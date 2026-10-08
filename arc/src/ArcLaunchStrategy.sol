// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {IFeeSplitter} from "launcher/src/interfaces/IFeeSplitter.sol";
import {PositionPlanner} from "launcher/src/libraries/PositionPlanner.sol";
import {Plan, Position, CurrencyAmounts, PositionDefinition} from "launcher/src/types/PositionPlannerTypes.sol";

/// @notice Single-sided locked V4 positions with immutable buy-input / sell-output native-USDC taxes.
contract ArcLaunchStrategy is ReentrancyGuard, BaseHook, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PositionPlanner for *;
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint24 public constant MAX_FEE = 100_000; // 10%; fee units are millionths.
    uint24 public constant OPENING_BUY_FEE = 990_000;
    uint64 public constant OPENING_SECONDS = 3;
    int24 public constant TICK_SPACING = 25;
    /// @dev Upper end of the opening-tick search; every profile must solve below it (checked in the constructor).
    int24 private constant MAX_OPENING_TICK = 251_325;
    /// @notice Gross native amount that buys half the supply at launch: 10_000e18 on Arc (native USDC).
    uint256 public immutable HALF_SUPPLY_COST;
    /// @notice Lower edge of every single-sided position: -160_100 on Arc. A chain whose native currency is worth
    ///         k times more than USDC shifts it up by about ln(k) / ln(1.0001) ticks together with HALF_SUPPLY_COST.
    int24 public immutable MIN_LAUNCH_TICK;
    address public immutable launcher;
    IPositionManager public immutable positionManager;
    IFeeSplitter public immutable feeSplitter;

    struct Fees {
        uint24 buy;
        uint24 sell;
        bool registered;
    }
    mapping(address => Fees) public fees;
    mapping(address => uint64) public launchedAt;
    mapping(address => uint256) public accruedNative;
    mapping(address => uint256) public accruedOpeningNative;
    address private initializingToken;
    uint256 private initializingPosition;
    error Invalid();

    /// @dev The two curve parameters are validated so `initialTick` is solvable for every accepted fee:
    ///      - one spacing above the floor, half the supply costs more than the target even at a zero fee, so the
    ///        search never returns the floor itself (where `liquidityAt` divides by zero) nor compares against it;
    ///      - at the search's upper end, half the supply costs no more than the target even at MAX_FEE, so a tick
    ///        at or under the target always exists and `HALF_SUPPLY_COST - costOfHalf(tick)` cannot underflow.
    ///      `costOfHalf` only grows with the fee, so checking fee 0 below and MAX_FEE above covers every fee.
    constructor(
        address launcher_,
        IPositionManager pm,
        IFeeSplitter splitter,
        uint256 halfSupplyCost_,
        int24 minLaunchTick_
    ) BaseHook(pm.poolManager()) {
        if (
            launcher_ == address(0) || address(pm).code.length == 0 || splitter.positionManager() != pm
                || halfSupplyCost_ == 0 || minLaunchTick_ % TICK_SPACING != 0 || minLaunchTick_ <= TickMath.MIN_TICK
                || minLaunchTick_ >= MAX_OPENING_TICK - 2 * TICK_SPACING
        ) {
            revert Invalid();
        }
        launcher = launcher_;
        positionManager = pm;
        feeSplitter = splitter;
        HALF_SUPPLY_COST = halfSupplyCost_;
        MIN_LAUNCH_TICK = minLaunchTick_;
        if (
            costOfHalf(minLaunchTick_ + TICK_SPACING, 0) <= halfSupplyCost_
                || costOfHalf(MAX_OPENING_TICK, MAX_FEE) > halfSupplyCost_
        ) revert Invalid();
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeAddLiquidity = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
        permissions.beforeDonate = true;
    }

    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal view override returns (bytes4) {
        if (sender != address(this)) revert Invalid();
        return IHooks.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata
    ) internal override returns (bytes4) {
        // PositionManager is public: only the one mint inside initializeDistribution is authorized.
        if (
            sender != address(positionManager) || initializingToken == address(0)
                || Currency.unwrap(key.currency1) != initializingToken || params.salt != bytes32(initializingPosition)
        ) {
            revert Invalid();
        }
        initializingToken = address(0);
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @notice Input fraction is min(0.5%, (buyFee + sellFee) / 8).
    /// The fee-scaled margin covers both automatic buys in a cycle. Zero-fee pools cannot auto-swap.
    function keeperSwapState(address token, bool buy) external view returns (uint160 sqrtPriceX96, uint256 maxInput) {
        if (!fees[token].registered) revert Invalid();
        PoolKey memory key = PoolKey(
            Currency.wrap(address(0)),
            Currency.wrap(token),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            TICK_SPACING,
            IHooks(address(this))
        );
        (sqrtPriceX96,,,) = StateLibrary.getSlot0(poolManager, key.toId());
        uint128 liquidity = StateLibrary.getLiquidity(poolManager, key.toId());
        // The opening price is exactly the upper tick; the first buy crosses into the position.
        if (liquidity == 0) {
            int24 tick = initialTick(fees[token].buy);
            if (sqrtPriceX96 == TickMath.getSqrtPriceAtTick(tick)) liquidity = liquidityAt(tick);
        }
        uint256 fraction = (uint256(fees[token].buy) + fees[token].sell) / 8;
        if (fraction > 5000) fraction = 5000;
        maxInput = FullMath.mulDiv(
            (buy
                    ? FullMath.mulDiv(liquidity, 1 << 96, sqrtPriceX96)
                    : FullMath.mulDiv(liquidity, sqrtPriceX96, 1 << 96)),
            fraction,
            1_000_000
        );
    }

    function launchProtectionVersion() external pure returns (uint256) { return 2; }

    /// @notice All buyers use the same clock. Zero/zero projects remain entirely fee-free.
    /// Every elapsed second divides the opening floor by four; at three seconds it expires.
    function launchProtection(address token) public view returns (uint64 startsAt, uint64 endsAt, uint24 buyFee) {
        Fees memory value = fees[token];
        if (!value.registered) revert Invalid();
        startsAt = launchedAt[token];
        endsAt = startsAt + (value.buy == 0 && value.sell == 0 ? 0 : OPENING_SECONDS);
        buyFee = value.buy;
        if (block.timestamp < endsAt) {
            uint24 floor = OPENING_BUY_FEE >> (2 * (block.timestamp - startsAt));
            if (floor > buyFee) buyFee = floor;
        }
    }

    function _swapFees(address token) private view returns (Fees memory value) {
        value = fees[token];
        (,, value.buy) = launchProtection(token);
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal override returns (bytes4, BeforeSwapDelta, uint24)
    {
        Fees memory value = _swapFees(Currency.unwrap(key.currency1));
        if (!value.registered || Currency.unwrap(key.currency0) != address(0)
            || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG || key.tickSpacing != TICK_SPACING
            || params.amountSpecified == 0 || params.amountSpecified < -int256(type(int128).max)
            || params.amountSpecified > int256(type(int128).max)) revert Invalid();
        uint256 tax;
        // Native is specified for exact-input buys and exact-output sells.
        if ((params.amountSpecified < 0) == params.zeroForOne) {
            tax = _specifiedTax(params, value);
            _accrue(Currency.unwrap(key.currency1), tax,
                params.zeroForOne ? uint256(-params.amountSpecified) : 0);
        }
        // No LP input fee: the hook charges only the native currency, once.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(tax)), 0), LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _specifiedTax(SwapParams calldata params, Fees memory value) private pure returns (uint256) {
        uint256 amount = uint256(params.zeroForOne ? -params.amountSpecified : params.amountSpecified);
        return FullMath.mulDivRoundingUp(amount, params.zeroForOne ? value.buy : value.sell,
            params.zeroForOne ? 1_000_000 : 1_000_000 - value.sell);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal override returns (bytes4, int128)
    {
        Fees memory value = _swapFees(Currency.unwrap(key.currency1));
        if ((params.amountSpecified < 0) == params.zeroForOne) {
            // Specified-currency tax cannot be corrected after swap. Reject partial fills atomically.
            if (int256(delta.amount0()) != params.amountSpecified + int256(_specifiedTax(params, value))) revert Invalid();
            return (IHooks.afterSwap.selector, 0);
        }
        uint256 amount = uint256(params.zeroForOne ? -int256(delta.amount0()) : int256(delta.amount0()));
        uint256 tax = FullMath.mulDivRoundingUp(amount, params.zeroForOne ? value.buy : value.sell,
            params.zeroForOne ? 1_000_000 - value.buy : 1_000_000);
        _accrue(Currency.unwrap(key.currency1), tax, params.zeroForOne ? amount + tax : 0);
        return (IHooks.afterSwap.selector, int128(int256(tax)));
    }

    function _accrue(address token, uint256 tax, uint256 grossBuyInput) private {
        if (tax > uint256(uint128(type(int128).max))) revert Invalid();
        if (tax == 0) return;
        accruedNative[token] += tax;
        if (grossBuyInput != 0) {
            uint256 baseTax = FullMath.mulDivRoundingUp(grossBuyInput, fees[token].buy, 1_000_000);
            // Both parts use the buyer's gross USDC, including exact-output router trades.
            accruedOpeningNative[token] += tax - baseTax;
        }
        // Claims avoid withdrawing USDC before the first buyer has settled its input.
        poolManager.mint(address(this), 0, tax);
    }

    function collectFees(address token) external nonReentrant returns (uint256 amount) {
        if (msg.sender != launcher || !fees[token].registered) revert Invalid();
        amount = accruedNative[token];
        if (amount == 0) return 0;
        accruedNative[token] = 0;
        accruedOpeningNative[token] = 0;
        poolManager.unlock(abi.encode(amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Invalid();
        uint256 amount = abi.decode(data, (uint256));
        poolManager.burn(address(this), 0, amount);
        poolManager.take(Currency.wrap(address(0)), launcher, amount);
        return "";
    }

    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal pure override returns (bytes4)
    {
        // Sponsor budgets through the factory's fundFees; LP donations have no allocation path.
        revert Invalid();
    }

    function liquidityAt(int24 tick) public view returns (uint128) {
        uint256 value = FullMath.mulDiv(
            TOTAL_SUPPLY, 1 << 96, TickMath.getSqrtPriceAtTick(tick) - TickMath.getSqrtPriceAtTick(MIN_LAUNCH_TICK)
        );
        if (value > type(uint128).max) revert Invalid();
        return uint128(value);
    }

    function costOfHalf(int24 tick, uint24 fee) public view returns (uint256) {
        uint160 price = TickMath.getSqrtPriceAtTick(tick);
        uint128 liquidity = liquidityAt(tick);
        uint160 next = SqrtPriceMath.getNextSqrtPriceFromOutput(price, liquidity, TOTAL_SUPPLY / 2, true);
        uint256 net = SqrtPriceMath.getAmount0Delta(next, price, liquidity, true);
        return FullMath.mulDivRoundingUp(net, 1_000_000, 1_000_000 - fee);
    }

    /// @notice Closest 25-aligned opening tick to HALF_SUPPLY_COST gross purchasing half the supply
    ///         (10,000 USDC on Arc).
    function initialTick(uint24 fee) public view returns (int24) {
        if (fee > MAX_FEE) revert Invalid();
        uint256 target = HALF_SUPPLY_COST;
        int24 low = MIN_LAUNCH_TICK / TICK_SPACING + 1;
        int24 high = MAX_OPENING_TICK / TICK_SPACING;
        while (low < high) {
            int24 mid = low + (high - low) / 2;
            if (costOfHalf(mid * TICK_SPACING, fee) > target) low = mid + 1;
            else high = mid;
        }
        int24 tick = low * TICK_SPACING;
        return target - costOfHalf(tick, fee) <= costOfHalf(tick - TICK_SPACING, fee) - target
            ? tick
            : tick - TICK_SPACING;
    }

    function initializeDistribution(address token, uint24 buyFee, uint24 sellFee)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (
            msg.sender != launcher || IERC20(token).totalSupply() != TOTAL_SUPPLY || fees[token].registered
                || sellFee > MAX_FEE
        ) revert Invalid();
        int24 tick = initialTick(buyFee);
        fees[token] = Fees(buyFee, sellFee, true);
        launchedAt[token] = uint64(block.timestamp);
        uint160 price = TickMath.getSqrtPriceAtTick(tick);
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), TOTAL_SUPPLY);
        if (IERC20(token).balanceOf(address(this)) - beforeBalance != TOTAL_SUPPLY) revert Invalid();
        PoolKey memory key = PoolKey(
            Currency.wrap(address(0)),
            Currency.wrap(token),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            TICK_SPACING,
            IHooks(address(this))
        );
        poolManager.initialize(key, price);
        PositionDefinition[] memory definitions = new PositionDefinition[](1);
        definitions[0] = PositionDefinition(MIN_LAUNCH_TICK - tick, 0, PositionPlanner.MPS, address(0));
        definitions.validate();
        (Position[] memory positions,) = definitions.resolve(
            price, TICK_SPACING, CurrencyAmounts({amount0: 0, amount1: TOTAL_SUPPLY}), address(this)
        );
        if (positions.length != 1 || positions[0].liquidity != liquidityAt(tick)) revert Invalid();
        Plan memory plan = positions.toPlan(key, ActionConstants.MSG_SENDER);
        IERC20(token).safeTransfer(address(positionManager), TOTAL_SUPPLY);
        id = positionManager.nextTokenId();
        initializingToken = token;
        initializingPosition = id;
        positionManager.modifyLiquidities(abi.encode(plan.actions, plan.params), block.timestamp);
        if (initializingToken != address(0)) revert Invalid();
        IERC721(address(positionManager)).transferFrom(address(this), address(feeSplitter), id);
        uint256 dust = IERC20(token).balanceOf(address(this)) - beforeBalance;
        if (dust != 0) IERC20(token).safeTransfer(address(0xdead), dust);
    }

    receive() external payable {}
}
