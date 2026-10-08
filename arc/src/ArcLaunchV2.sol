// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {ArcLaunchStrategy} from "./ArcLaunchStrategy.sol";
import {ArcToken} from "./ArcLaunch.sol";
import {IFeeSplitter, FeeSplit} from "launcher/src/interfaces/IFeeSplitter.sol";
import {ArcRewards} from "./ArcRewards.sol";
import {ArcProjectTreasury} from "./ArcProjectTreasury.sol";
import {ArcProjectTreasuryDeployer} from "./ArcProjectTreasuryDeployer.sol";

/// @notice Project fees split five ways; SPARK's community share joins its buyback budget.
contract ArcLaunchV2 is ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    uint256 public constant ECONOMICS_VERSION = 3;
    bool public constant INDEPENDENT_FEES = true;
    bool public constant KEEPER_GAS_SUPPORT = true;
    uint256 public constant KEEPER_PRICE_GUARD_VERSION = 2;
    /// @notice How far ahead of the mined block a public trade's deadline may sit.
    /// @dev A wallet signs its deadline before the transaction is mined, so this ceiling is what
    ///      bounds how long a signed trade can wait. The 100-wallet run on 2026-09-20 measured
    ///      quote-to-block times of p95 181.7 s and max 192.7 s against a 120 s ceiling, and 119 of
    ///      240 buys reverted with nothing longer available to sign. The ceiling stays because it
    ///      limits how long a signed trade remains a free option; `minOut` is the price protection.
    ///      The keeper's own calls keep a tighter 120 s — it signs 30 s deadlines anyway.
    uint256 public constant TRADE_DEADLINE_WINDOW = 900;
    /// @notice Keeper gas policy, in the chain's native currency. On Arc (native USDC) these were the constants
    ///         2e18 / 1e18 / 0.25e18 / 0.01e18 / 2e18; another chain states its own in its profile.
    /// @dev The keeper is topped up to `KEEPER_GAS_TRIGGER`, at most `KEEPER_GAS_MAX_TOPUP` and at least
    ///      `KEEPER_GAS_MIN_TOPUP` per payment, at most `KEEPER_GAS_DAILY_LIMIT` per UTC day, and only out of
    ///      platform revenue; `KEEPER_GAS_BUFFER` of that revenue is never claimable by `operations`.
    uint256 public immutable KEEPER_GAS_TRIGGER;
    uint256 public immutable KEEPER_GAS_BUFFER;
    uint256 public immutable KEEPER_GAS_MAX_TOPUP;
    uint256 public immutable KEEPER_GAS_MIN_TOPUP;
    uint256 public immutable KEEPER_GAS_DAILY_LIMIT;
    uint256 public constant INTERVAL = 180;
    uint256 public constant SUPPLY = 1_000_000_000e18;
    address public immutable administrator;
    address public immutable keeper;
    address public immutable operations; // The 1% platform treasury, never the execution wallet.
    uint256 public immutable minBuyback;
    IPositionManager public immutable positionManager;
    IPoolManager public immutable poolManager;
    ArcProjectTreasuryDeployer public immutable projectTreasuryDeployer;
    ArcLaunchStrategy public strategy;
    IFeeSplitter public feeSplitter;
    address public platformToken;
    address public projectTeam;
    mapping(address => bool) public unboundProjectTreasury;
    uint256 public operationsCredit;
    uint256 public nativeAccounted;
    uint256 private keeperGasDay;
    uint256 public keeperGasPaidToday;
    uint256 public totalKeeperGasPaid;

    struct TokenState {
        uint256 positionId;
        uint256 pendingNative;
        uint256 pendingTokens; // ABI retained for archived clients; USDC-only fees leave this zero.
        uint256 lastBurnAt;
        uint256 totalBuyback;
        uint256 totalBurned;
        uint256 cycles;
    }

    struct KeeperGas {
        uint256 trigger;
        uint256 buffer;
        uint256 maxTopup;
        uint256 minTopup;
        uint256 dailyLimit;
    }

    struct Terms {
        uint24 fee;
        address community;
        ArcRewards rewards;
    }
    mapping(address => TokenState) public tokens;
    mapping(address => Terms) public terms;
    mapping(uint256 => address) public tokenForPosition;
    mapping(address => uint256) public communityCredit;
    event Launched(
        address indexed token,
        address indexed creator,
        uint256 indexed positionId,
        string name,
        string symbol,
        string metadataURI
    );
    event FeesCollected(uint256 indexed tokenId, address indexed token, uint256 nativeAmount, uint256 tokenAmount);
    event FeesAllocated(
        address indexed token,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 ownBuyback,
        uint256 jetBuyback,
        uint256 distributions,
        uint256 community,
        uint256 platform
    );
    event Burned(
        address indexed token,
        uint256 nativeAmount,
        uint256 bought,
        uint256 feeTokens,
        uint256 totalBurned,
        uint256 cycle
    );
    event Traded(address indexed token, address indexed trader, bool buy, uint256 amountIn, uint256 amountOut);
    event PlatformConfigured(address indexed token);
    event ProjectTeamConfigured(address indexed team);
    event ProjectTreasuryCreated(address indexed treasury, address indexed creator);
    event TokenConfigured(address indexed token, uint24 buyFee, uint24 sellFee, address community, address rewards);
    event OperationsClaimed(uint256 amount);
    event CommunityClaimed(address indexed token, address indexed recipient, uint256 amount);
    event KeeperGasFunded(address indexed sender, uint256 amount);
    event KeeperGasPaid(address indexed keeper, uint256 amount);
    event PlatformBuybackFunded(address indexed from, uint256 amount);
    error Unauthorized();
    error InvalidConfiguration();
    error UnknownToken();
    error InvalidAmount();
    error NotDue();
    error Slippage();
    error TransferFailed();

    /// @dev No chain allowlist: the deploy script checks the connected chain against its committed profile.
    ///      Keeper gas invariants: every payment is non-zero (`minTopup != 0`), a single payment can reach
    ///      its floor and never overshoots the target or the day (`minTopup <= maxTopup <= trigger`,
    ///      `maxTopup <= dailyLimit`), so `keeperGasPaidToday <= KEEPER_GAS_DAILY_LIMIT` always holds and
    ///      `KEEPER_GAS_DAILY_LIMIT - paid` never underflows; the unclaimable buffer covers at least one payment.
    constructor(
        IPositionManager pm,
        address keeper_,
        address operations_,
        uint256 minBuyback_,
        KeeperGas memory gas_
    ) {
        if (
            address(pm).code.length == 0 || keeper_ == address(0) || operations_ == address(0)
                || operations_ == keeper_ || minBuyback_ == 0 || gas_.minTopup == 0 || gas_.minTopup > gas_.maxTopup
                || gas_.maxTopup > gas_.trigger || gas_.maxTopup > gas_.dailyLimit || gas_.buffer < gas_.maxTopup
        ) revert InvalidConfiguration();
        KEEPER_GAS_TRIGGER = gas_.trigger;
        KEEPER_GAS_BUFFER = gas_.buffer;
        KEEPER_GAS_MAX_TOPUP = gas_.maxTopup;
        KEEPER_GAS_MIN_TOPUP = gas_.minTopup;
        KEEPER_GAS_DAILY_LIMIT = gas_.dailyLimit;
        administrator = msg.sender;
        positionManager = pm;
        poolManager = pm.poolManager();
        projectTreasuryDeployer = new ArcProjectTreasuryDeployer();
        keeper = keeper_;
        operations = operations_;
        minBuyback = minBuyback_;
    }

    function configure(ArcLaunchStrategy value) external {
        if (msg.sender != administrator || address(strategy) != address(0)) revert Unauthorized();
        IFeeSplitter splitter = value.feeSplitter();
        FeeSplit[] memory splits = splitter.getSplits();
        if (
            value.launcher() != address(this) || value.positionManager() != positionManager
                || value.launchProtectionVersion() != 2
                || value.poolManager() != poolManager || splitter.positionManager() != positionManager
                || splits.length != 1 || splits[0].recipient != address(this) || splits[0].nativeBps != 10_000
                || splits[0].tokenBps != 10_000 || !splits[0].useCallback
        ) revert InvalidConfiguration();
        strategy = value;
        feeSplitter = splitter;
    }

    function rewards() external view returns (ArcRewards) {
        return terms[platformToken].rewards;
    }

    /// @notice Set the team once, before opening project launches.
    function setProjectTeam(address team) external {
        if (msg.sender != administrator || projectTeam != address(0) || team == address(0)
            || team == keeper || team == address(this)) revert InvalidConfiguration();
        projectTeam = team;
        emit ProjectTeamConfigured(team);
    }

    /// @notice Create a project treasury controlled only by votes of that project's future token.
    function createProjectTreasury() external returns (address treasury) {
        if (platformToken == address(0) || projectTeam == address(0)) revert InvalidConfiguration();
        treasury = projectTreasuryDeployer.deploy(msg.sender, projectTeam);
        unboundProjectTreasury[treasury] = true;
        emit ProjectTreasuryCreated(treasury, msg.sender);
    }

    function tradeFees(address token) external view returns (uint24 buyFee, uint24 sellFee) {
        _known(token);
        (buyFee, sellFee,) = strategy.fees(token);
    }

    function launch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint24 buyFee,
        uint24 sellFee,
        address community
    ) external nonReentrant returns (address token) {
        if (
            address(strategy) == address(0) || bytes(name).length == 0 || bytes(name).length > 64
                || bytes(symbol).length == 0 || bytes(symbol).length > 12 || bytes(metadataURI).length > 512
                || buyFee > strategy.MAX_FEE() || sellFee > strategy.MAX_FEE()
                || community == operations || community == keeper || community == address(this)
        ) revert InvalidConfiguration();
        // The administrator's first launch is the platform token; subsequent launches need this factory's vault.
        bool isPlatform = platformToken == address(0);
        if (isPlatform ? msg.sender != administrator || community != address(0)
            : !unboundProjectTreasury[community] || ArcProjectTreasury(payable(community)).creator() != msg.sender)
            revert InvalidConfiguration();
        if (!isPlatform) unboundProjectTreasury[community] = false;
        token = address(new ArcToken(name, symbol, address(this), metadataURI));
        IERC20(token).forceApprove(address(strategy), SUPPLY);
        uint256 id = strategy.initializeDistribution(token, buyFee, sellFee);
        {
            (PoolKey memory key,) = positionManager.getPoolAndPositionInfo(id);
            if (
                IERC721(address(positionManager)).ownerOf(id) != address(feeSplitter)
                    || Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1) != token
                    || address(key.hooks) != address(strategy) || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG
                    || key.tickSpacing != 25
            ) revert InvalidConfiguration();
        }
        tokens[token].positionId = id;
        tokenForPosition[id] = token;
        terms[token] =
            Terms(LPFeeLibrary.DYNAMIC_FEE_FLAG, community, new ArcRewards(IERC20(token), address(this), keeper));
        if (isPlatform) {
            platformToken = token;
            emit PlatformConfigured(token);
        } else ArcProjectTreasury(payable(community)).bind(token);
        emit Launched(token, msg.sender, id, name, symbol, metadataURI);
        emit TokenConfigured(token, buyFee, sellFee, community, address(terms[token].rewards));
    }

    function collectFees(address token) external nonReentrant returns (uint256 nativeAmount, uint256 tokenAmount) {
        _known(token);
        uint256 openingAmount = strategy.accruedOpeningNative(token);
        nativeAmount = strategy.collectFees(token);
        if (nativeAmount != 0) {
            _credit(token, nativeAmount, openingAmount);
            emit FeesCollected(tokens[token].positionId, token, nativeAmount, 0);
        }
        _topUpKeeper();
        return (nativeAmount, 0);
    }

    function fundFees(address token) external payable nonReentrant {
        _known(token);
        if (msg.value == 0) revert InvalidAmount();
        _credit(token, msg.value, 0);
    }

    /// @notice Adds the full amount to the platform-token buyback budget; no five-way split.
    /// @dev Permissionless. Funds can leave only through the guarded executeBurn path.
    function fundPlatformBuyback() external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        if (platformToken == address(0)) revert InvalidConfiguration();
        _jet(msg.value);
        nativeAccounted += msg.value;
        emit PlatformBuybackFunded(msg.sender, msg.value);
    }

    function _jet(uint256 amount) private {
        tokens[platformToken].pendingNative += amount;
    }

    function _credit(address token, uint256 nativeAmount, uint256 openingAmount) private {
        uint256 baseAmount = nativeAmount - openingAmount;
        uint256 own = baseAmount * 83 / 100;
        uint256 jet = baseAmount * 7 / 100 + openingAmount;
        uint256 distribution = baseAmount * 5 / 100;
        uint256 community = baseAmount * 4 / 100;
        if (token == platformToken) {
            jet += community;
            community = 0;
        }
        uint256 platform = nativeAmount - own - jet - distribution - community;
        tokens[token].pendingNative += own;
        _jet(jet);
        communityCredit[token] += community;
        operationsCredit += platform;
        nativeAccounted += nativeAmount - distribution;
        if (distribution != 0) terms[token].rewards.fundNative{value: distribution}();
        emit FeesAllocated(token, nativeAmount, 0, own, jet, distribution, community, platform);
    }

    function claimOperations() external nonReentrant {
        uint256 amount = operationsClaimable();
        if (amount == 0) revert InvalidAmount();
        operationsCredit -= amount;
        nativeAccounted -= amount;
        (bool success,) = operations.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit OperationsClaimed(amount);
    }

    /// @notice Keep a platform-funded buffer; project burn/reward/community budgets cannot fund gas.
    function operationsClaimable() public view returns (uint256) {
        return operationsCredit > KEEPER_GAS_BUFFER ? operationsCredit - KEEPER_GAS_BUFFER : 0;
    }

    /// @notice Seed the buffer before first operation or replenish it when fee revenue is insufficient.
    function fundKeeperGas() external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        operationsCredit += msg.value;
        nativeAccounted += msg.value;
        emit KeeperGasFunded(msg.sender, msg.value);
        _topUpKeeper();
    }

    function keeperGasAvailable() public view returns (uint256 amount) {
        if (keeper.balance >= KEEPER_GAS_TRIGGER) return 0;
        uint256 paid = keeperGasDay == block.timestamp / 1 days ? keeperGasPaidToday : 0;
        amount = KEEPER_GAS_TRIGGER - keeper.balance;
        if (amount > operationsCredit) amount = operationsCredit;
        if (amount > KEEPER_GAS_MAX_TOPUP) amount = KEEPER_GAS_MAX_TOPUP;
        if (amount > KEEPER_GAS_DAILY_LIMIT - paid) amount = KEEPER_GAS_DAILY_LIMIT - paid;
        if (amount < KEEPER_GAS_MIN_TOPUP) return 0;
    }

    /// @notice Anyone may sponsor this call, including when the keeper itself has zero gas.
    function topUpKeeper() public nonReentrant returns (uint256) {
        return _topUpKeeper();
    }

    function _topUpKeeper() private returns (uint256 amount) {
        amount = keeperGasAvailable();
        if (amount == 0) return 0;
        uint256 day = block.timestamp / 1 days;
        if (keeperGasDay != day) {
            keeperGasDay = day;
            keeperGasPaidToday = 0;
        }
        operationsCredit -= amount;
        nativeAccounted -= amount;
        keeperGasPaidToday += amount;
        totalKeeperGasPaid += amount;
        (bool success,) = keeper.call{value: amount, gas: 30_000}("");
        if (!success) {
            operationsCredit += amount;
            nativeAccounted += amount;
            keeperGasPaidToday -= amount;
            totalKeeperGasPaid -= amount;
            return 0;
        }
        emit KeeperGasPaid(keeper, amount);
    }

    function claimCommunity(address token) external nonReentrant {
        _known(token);
        uint256 amount = communityCredit[token];
        if (amount == 0) revert InvalidAmount();
        communityCredit[token] = 0;
        nativeAccounted -= amount;
        address recipient = terms[token].community;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit CommunityClaimed(token, recipient, amount);
    }

    function executeBurn(address token, uint256 expectedNative, uint256 minOut, uint256 deadline)
        external
        nonReentrant
    {
        if (msg.sender != keeper) revert Unauthorized();
        _known(token);
        TokenState storage state = tokens[token];
        if (block.timestamp < state.lastBurnAt + INTERVAL) revert NotDue();
        if (deadline < block.timestamp || deadline > block.timestamp + 120) revert InvalidAmount();
        uint256 amount = expectedNative;
        if (amount > state.pendingNative || amount < minBuyback) {
            revert InvalidAmount();
        }
        _checkKeeperAmount(token, true, amount);
        state.pendingNative -= amount;
        nativeAccounted -= amount;
        uint256 bought = _swap(token, true, amount, minOut, address(this));
        uint256 burned = bought;
        ArcToken(token).burn(burned);
        state.lastBurnAt = block.timestamp;
        state.totalBuyback += amount;
        state.totalBurned += burned;
        state.cycles++;
        emit Burned(token, amount, bought, 0, burned, state.cycles);
        _topUpKeeper();
    }

    /// @notice Public native-USDC buy/sell against the same registered V4 pool.
    function trade(address token, bool buy, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        _known(token);
        if (
            deadline < block.timestamp || deadline > block.timestamp + TRADE_DEADLINE_WINDOW
                || msg.value != (buy ? amountIn : 0)
        ) {
            revert InvalidAmount();
        }
        if (!buy) IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        if (msg.sender == address(terms[token].rewards)) _checkKeeperAmount(token, buy, amountIn);
        amountOut = _swap(token, buy, amountIn, minOut, msg.sender);
        emit Traded(token, msg.sender, buy, amountIn, amountOut);
    }

    function _swap(address token, bool buy, uint256 amountIn, uint256 minOut, address recipient)
        private
        returns (uint256)
    {
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max)) || minOut == 0) {
            revert InvalidAmount();
        }
        return abi.decode(poolManager.unlock(abi.encode(token, buy, amountIn, minOut, recipient)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        (address token, bool buy, uint256 amountIn, uint256 minOut, address recipient) =
            abi.decode(data, (address, bool, uint256, uint256, address));
        (PoolKey memory key,) = positionManager.getPoolAndPositionInfo(tokens[token].positionId);
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: buy,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 input = buy ? delta.amount0() : delta.amount1();
        int128 output = buy ? delta.amount1() : delta.amount0();
        // Reject partial fills: no leftover input can accidentally become somebody else's fees.
        if (input >= 0 || uint256(-int256(input)) != amountIn || output <= 0 || uint256(int256(output)) < minOut) {
            revert Slippage();
        }
        if (buy) {
            poolManager.sync(key.currency0);
            poolManager.settle{value: amountIn}();
        } else {
            poolManager.sync(key.currency1);
            IERC20(token).safeTransfer(address(poolManager), amountIn);
            poolManager.settle();
        }
        uint256 amountOut = uint256(int256(output));
        poolManager.take(buy ? key.currency1 : key.currency0, recipient, amountOut);
        return abi.encode(amountOut);
    }

    function _known(address token) private view {
        if (tokens[token].positionId == 0) revert UnknownToken();
    }

    function _checkKeeperAmount(address token, bool buy, uint256 amount) private view {
        (, uint256 limit) = strategy.keeperSwapState(token, buy);
        if (amount > limit) revert InvalidAmount();
    }

    receive() external payable {
        if (msg.sender != address(feeSplitter) && msg.sender != address(poolManager)) revert Unauthorized();
    }
}
