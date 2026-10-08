// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {ArgusProjectTreasury} from "./ArgusGovernance.sol";
import {IProjectTreasuryFactory} from "./ArcProjectTreasury.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IArgusCustodyPortal {
    function poolManager() external view returns (IPoolManager);
    function positionManager() external view returns (address);
    function launches(address token) external view returns (address creator, int24 tickStart, bool tokenIsToken0,
        address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset);
}
interface IArgusPositionLiquidity { function getPositionLiquidity(uint256 id) external view returns (uint128); }

/// @notice Trades and Gas-sized token distributions for registered project wallets. Holds no persistent budgets or user deposits.
/// @dev Custody and per-project accounting remain in the backend. This is a fixed V4 settlement path, not a custody account.
contract ArgusCustodyRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    IArgusCustodyPortal public constant portal = IArgusCustodyPortal(0xB021Be536808f551b31789422Fd28a6c9c6e97Da);
    IERC20 public constant quote = IERC20(0x3600000000000000000000000000000000000000);
    address public immutable custody;
    IPoolManager public immutable poolManager;
    address public immutable platformToken;
    address public immutable operations;
    bool public immutable governanceEnabled;
    mapping(address => address) public community;
    mapping(address => address) public initiator;
    mapping(address => address) public projectOf;
    mapping(address => uint256) public totalPaid;
    mapping(address => uint256) public windowStarted;
    mapping(address => uint256) public quoteSpent;
    event Traded(address indexed token, address indexed trader, bool buy, uint256 amountIn, uint256 amountOut);
    event Burned(address indexed token, uint256 quoteUsdc6, uint256 tokens);
    event RewardPaid(address indexed token, uint256 indexed payoutIndex, address indexed recipient, uint256 amount);
    event Registered(address indexed token, address indexed initiator, address treasury);
    event TreasuryFunded(address indexed token, address indexed treasury, uint256 quoteUsdc6, bool platform);
    event PlatformBuybackFunded(address indexed sender, uint256 quoteUsdc6);
    error Invalid();
    function independentWallets() external pure returns (bool) { return true; }

    constructor(address custody_, address platform_, address operations_, bool governance_) {
        if (block.chainid != 5042 || custody_ == address(0) || operations_ == address(0) || operations_ == custody_
            || (governance_ && operations_.code.length == 0) || platform_.code.length == 0) revert Invalid();
        custody = custody_;
        poolManager = portal.poolManager();
        platformToken = platform_;
        operations = operations_;
        governanceEnabled = governance_;
        (address owner,,,,,,,,,,address asset) = portal.launches(platform_);
        if (owner != custody_ || asset != address(quote)) revert Invalid();
        initiator[platform_] = custody_;
    }

    function register(address token, address initiator_) external nonReentrant returns (address vault) {
        if (token == platformToken || initiator_ == address(0) || initiator[token] != address(0)) revert Invalid();
        (address owner,,,,,,,,,,) = portal.launches(token);
        if (msg.sender != owner || owner == address(0)) revert Invalid();
        if (owner != custody) {
            if (projectOf[owner] != address(0)) revert Invalid();
            projectOf[owner] = token;
        }
        poolKey(token);
        if (!governanceEnabled && owner == custody) revert Invalid();
        vault = governanceEnabled ? address(new ArgusProjectTreasury(IProjectTreasuryFactory(address(this)), initiator_, custody)) : owner;
        initiator[token] = initiator_;
        community[token] = vault;
        if (governanceEnabled) ArgusProjectTreasury(payable(vault)).bind(token);
        emit Registered(token, initiator_, vault);
    }
    function terms(address token) external view returns (uint24 fee, address vault, address rewards) {
        return (10000, community[token], address(this));
    }
    function fundTreasury(address token, bool platform, uint256 quoteUsdc6) external nonReentrant {
        if (!_owns(token) || initiator[token] == address(0) || quoteUsdc6 == 0 || (!platform && !governanceEnabled)) revert Invalid();
        address to = platform ? operations : community[token];
        if (to == address(0)) revert Invalid();
        quote.safeTransferFrom(msg.sender, to, quoteUsdc6);
        emit TreasuryFunded(token, to, quoteUsdc6, platform);
    }
    // 1% is transferred directly to the fixed vault. There is no intermediate unclaimed pot.
    function operationsClaimable() external pure returns (uint256) { return 0; }
    function claimOperations() external pure { revert Invalid(); }
    function fundPlatformBuyback() external payable { revert Invalid(); }
    function fundPlatformBuybackUsdc6(uint256 amount) external nonReentrant {
        if (msg.sender != operations || amount == 0) revert Invalid();
        quote.safeTransferFrom(operations, custody, amount);
        emit PlatformBuybackFunded(operations, amount);
    }

    function poolKey(address token) public view returns (PoolKey memory key) {
        (address owner, , bool token0,, address hook,,,,uint256 id,,address asset) = portal.launches(token);
        if ((owner != custody && projectOf[owner] != token) || id == 0 || asset != address(quote)) revert Invalid();
        key = PoolKey(Currency.wrap(token0 ? token : asset), Currency.wrap(token0 ? asset : token), 10000, 200, IHooks(hook));
    }

    /// @notice Safe automatic input at 0.5% of the pool's virtual quote reserve. Quote amounts are USDC6.
    function keeperSwapState(address token) public view returns (uint160 sqrtPriceX96, uint256 maxQuote6) {
        PoolKey memory key = poolKey(token);
        (sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint128 liquidity = poolManager.getLiquidity(key.toId());
        // At the exact opening boundary the single-sided position is just outside active liquidity.
        if (liquidity == 0) {
            (,int24 start,,,,,,,uint256 id,,) = portal.launches(token);
            if (sqrtPriceX96 != TickMath.getSqrtPriceAtTick(start)) revert Invalid();
            liquidity = IArgusPositionLiquidity(portal.positionManager()).getPositionLiquidity(id);
        }
        bool quote0 = Currency.unwrap(key.currency0) == address(quote);
        uint256 reserve = quote0 ? FullMath.mulDiv(liquidity, 1 << 96, sqrtPriceX96)
            : FullMath.mulDiv(liquidity, sqrtPriceX96, 1 << 96);
        maxQuote6 = reserve / 200;
        if (block.timestamp < windowStarted[token] + 180) {
            maxQuote6 = maxQuote6 > quoteSpent[token] ? maxQuote6 - quoteSpent[token] : 0;
        }
    }

    /// @notice API amounts remain native18 for USDC and token18 for tokens. ERC-20 settlement uses quote6.
    function trade(address token, bool buy, uint256 amountIn, uint256 minOut, uint256 deadline)
        external nonReentrant returns (uint256 amountOut)
    {
        uint256 input = buy ? _quote6(amountIn) : amountIn;
        uint256 minimum = buy ? minOut : _quote6(minOut);
        amountOut = _trade(token, buy, input, minimum, deadline, msg.sender);
        if (!buy) amountOut *= 1e12;
        emit Traded(token, msg.sender, buy, amountIn, amountOut);
    }

    function buyAndBurn(address token, uint256 quoteUsdc6, uint256 minTokens, uint256 deadline)
        external nonReentrant returns (uint256 bought)
    {
        if (!_owns(token) && !(token == platformToken && projectOf[msg.sender] != address(0))) revert Invalid();
        bought = _trade(token, true, quoteUsdc6, minTokens, deadline, address(0xdead));
        emit Burned(token, quoteUsdc6, bought);
    }

    function _trade(address token, bool buy, uint256 input, uint256 minimum, uint256 deadline, address recipient)
        private returns (uint256 output)
    {
        if (deadline > block.timestamp + 120 || input == 0 || input > uint256(uint128(type(int128).max)) || minimum == 0 || block.timestamp > deadline) revert Invalid();
        if (msg.sender == custody || projectOf[msg.sender] != address(0)) {
            if (!buy || deadline > block.timestamp + 30) revert Invalid();
            (, uint256 cap) = keeperSwapState(token);
            if (input > cap) revert Invalid();
            if (block.timestamp >= windowStarted[token] + 180) {windowStarted[token] = block.timestamp; quoteSpent[token] = 0;}
            quoteSpent[token] += input;
        }
        PoolKey memory key = poolKey(token);
        IERC20 inputAsset = buy ? quote : IERC20(token);
        IERC20 outputAsset = buy ? IERC20(token) : quote;
        inputAsset.safeTransferFrom(msg.sender, address(this), input);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(inputAsset);
        output = abi.decode(poolManager.unlock(abi.encode(key, zeroForOne, input)), (uint256));
        if (output < minimum) revert Invalid();
        outputAsset.safeTransfer(recipient, output);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Invalid();
        (PoolKey memory key, bool zeroForOne, uint256 input) = abi.decode(data, (PoolKey,bool,uint256));
        BalanceDelta delta = poolManager.swap(key, SwapParams(zeroForOne, -int256(input),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        int128 got = zeroForOne ? delta.amount1() : delta.amount0();
        if (paid >= 0 || got <= 0 || uint256(-int256(paid)) != input) revert Invalid();
        Currency inputCurrency = zeroForOne ? key.currency0 : key.currency1;
        Currency outputCurrency = zeroForOne ? key.currency1 : key.currency0;
        poolManager.sync(inputCurrency);
        IERC20(Currency.unwrap(inputCurrency)).safeTransfer(address(poolManager), input);
        poolManager.settle();
        poolManager.take(outputCurrency, address(this), uint128(got));
        return abi.encode(uint256(uint128(got)));
    }

    function distribute(address token, uint256 expectedTotalPaid, address[] calldata recipients) external nonReentrant {
        if (!_owns(token) || initiator[token] == address(0) || recipients.length < 100 || totalPaid[token] != expectedTotalPaid) revert Invalid();
        (,,,address locker,address hook,address splitter,,,,,) = portal.launches(token);
        poolKey(token);
        totalPaid[token] += recipients.length;
        IERC20(token).safeTransferFrom(msg.sender, address(this), recipients.length * 10e18);
        address previous;
        for (uint256 i; i < recipients.length; i++) {
            address to = recipients[i];
            if (to <= previous || to == custody || to == msg.sender || projectOf[to] != address(0) || to == address(this) || to == token || to == address(portal)
                || to == operations || to == community[token] || to == address(poolManager) || to == locker || to == hook || to == splitter || to == address(0xdead)) revert Invalid();
            previous = to;
            IERC20(token).safeTransfer(to, 10e18);
            emit RewardPaid(token, expectedTotalPaid + i, to, 10e18);
        }
    }

    function _owns(address token) private view returns (bool) {
        (address owner,,,,,,,,,,) = portal.launches(token);
        return owner == msg.sender;
    }

    function _quote6(uint256 amount18) private pure returns (uint256) {
        if (amount18 == 0 || amount18 % 1e12 != 0) revert Invalid();
        return amount18 / 1e12;
    }
}
