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
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {InstantLaunchStrategy} from "launcher/src/strategies/InstantLaunchStrategy.sol";
import {IFeeSplitter, FeeSplit} from "launcher/src/interfaces/IFeeSplitter.sol";
import {ArcRewards} from "./ArcRewards.sol";

/// @notice No owner, mint, transfer tax, pause or blacklist. burn() reduces totalSupply.
contract ArcToken is ERC20Burnable {
    string private _contractURI;

    constructor(string memory name_, string memory symbol_, address recipient, string memory uri_)
        ERC20(name_, symbol_)
    {
        _contractURI = uri_;
        _mint(recipient, 1_000_000_000e18);
    }

    /// @notice ERC-7572 contract-level metadata: where this token's image, description and links live.
    /// @dev The same string the factory puts in its `Launched` event, readable without knowing the
    ///      factory or decoding its event. That is the whole point: an indexer that has only the token
    ///      address can still find the metadata. ERC-7572's `ContractURIUpdated` event is deliberately
    ///      absent — this value is written once in the constructor and there is no path that changes
    ///      it, so an event promising updates would describe something that cannot happen.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }
}

/// @notice Arc native USDC uses 18 decimals here, NOT the 6-decimal ERC20 facade.
/// @dev A keeper collects fees and executes eligible burns; funds never enter its wallet.
contract ArcLaunch is ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint256 public constant INTERVAL = 180;
    uint256 public constant SUPPLY = 1_000_000_000e18;
    // Native USDC is token0. Closest 25-aligned tick to 10,000 USDC gross buying half the supply.
    // With the 0.25% pool fee, a fresh pool quotes ~499,749,186.846 tokens; no graduation or migration.
    // ponytail: retain the upstream tick grid; stricter calibration needs a different LP range/strategy.
    int24 public constant INITIAL_TICK = 115_150;
    address public immutable administrator;
    address public immutable keeper;
    address public immutable operations;
    uint256 public immutable minBuyback;
    IPositionManager public immutable positionManager;
    IPoolManager public immutable poolManager;
    InstantLaunchStrategy public strategy;
    IFeeSplitter public feeSplitter;
    address public platformToken;
    ArcRewards public rewards;
    uint256 public operationsCredit;
    uint256 public nativeAccounted;
    uint256 private unassignedPlatform;

    struct TokenState {
        uint256 positionId;
        uint256 pendingNative;
        uint256 pendingTokens;
        uint256 lastBurnAt;
        uint256 totalBuyback;
        uint256 totalBurned;
        uint256 cycles;
    }
    mapping(address => TokenState) public tokens;
    mapping(uint256 => address) public tokenForPosition;

    event Launched(
        address indexed token,
        address indexed creator,
        uint256 indexed positionId,
        string name,
        string symbol,
        string metadataURI
    );
    event FeesReceived(
        address indexed token,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 projectShare,
        uint256 platformShare,
        uint256 operationsShare
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
    event OperationsClaimed(uint256 amount);
    event RewardsConfigured(address indexed rewards);

    error Unauthorized();
    error InvalidConfiguration();
    error UnknownToken();
    error InvalidAmount();
    error NotDue();
    error Slippage();
    error TransferFailed();

    constructor(IPositionManager pm, address keeper_, address operations_, uint256 minBuyback_) {
        if (
            (block.chainid != 5042002 && block.chainid != 5042) || address(pm).code.length == 0 || keeper_ == address(0)
                || operations_ == address(0) || minBuyback_ == 0
        ) revert InvalidConfiguration();
        administrator = msg.sender;
        positionManager = pm;
        poolManager = pm.poolManager();
        keeper = keeper_;
        operations = operations_;
        minBuyback = minBuyback_;
    }

    /// @notice One-time binding after deploying the official splitter and instant strategy.
    function configure(InstantLaunchStrategy strategy_) external {
        if (msg.sender != administrator || address(strategy) != address(0)) revert Unauthorized();
        IFeeSplitter splitter = strategy_.feeSplitter();
        FeeSplit[] memory splits = splitter.getSplits();
        if (
            strategy_.launcher() != address(this) || strategy_.positionManager() != positionManager
                || strategy_.poolManager() != poolManager || splitter.positionManager() != positionManager
                || address(strategy_.beneficiaryVault()) != address(0) || strategy_.initialTick() != INITIAL_TICK
                || splits.length != 1 || splits[0].recipient != address(this) || splits[0].nativeBps != 10_000
                || splits[0].tokenBps != 10_000 || !splits[0].useCallback
        ) revert InvalidConfiguration();
        strategy = strategy_;
        feeSplitter = splitter;
    }

    function setPlatformToken(address token) external {
        if (msg.sender != administrator || platformToken != address(0)) revert Unauthorized();
        _known(token);
        platformToken = token;
        tokens[token].pendingNative += unassignedPlatform;
        unassignedPlatform = 0;
        emit PlatformConfigured(token);
    }

    function setRewards(ArcRewards rewards_) external {
        if (
            msg.sender != administrator || address(rewards) != address(0) || platformToken == address(0)
                || address(rewards_.token()) != platformToken || rewards_.launch() != address(this)
                || rewards_.keeper() != keeper
        ) revert InvalidConfiguration();
        rewards = rewards_;
        emit RewardsConfigured(address(rewards_));
    }

    /// @notice Token creation, LP locking and burn enrollment succeed or revert together.
    function launch(string calldata name, string calldata symbol, string calldata metadataURI)
        external
        nonReentrant
        returns (address token)
    {
        if (
            address(strategy) == address(0) || bytes(name).length == 0 || bytes(name).length > 64
                || bytes(symbol).length == 0 || bytes(symbol).length > 12 || bytes(metadataURI).length > 512
        ) revert InvalidConfiguration();
        token = address(new ArcToken(name, symbol, address(this), ""));
        uint256 positionId = positionManager.nextTokenId();
        IERC20(token).forceApprove(address(strategy), SUPPLY);
        strategy.initializeDistribution(token, SUPPLY, abi.encode(msg.sender), bytes32(0));
        (PoolKey memory key,) = positionManager.getPoolAndPositionInfo(positionId);
        if (
            IERC721(address(positionManager)).ownerOf(positionId) != address(feeSplitter)
                || Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1) != token
                || address(key.hooks) != address(0) || key.fee != 2500 || key.tickSpacing != 25
                || positionManager.nextTokenId() != positionId + 1
        ) revert InvalidConfiguration();
        tokens[token].positionId = positionId;
        tokenForPosition[positionId] = token;
        emit Launched(token, msg.sender, positionId, name, symbol, metadataURI);
    }

    /// @dev Only the fixed FeeSplitter can attribute its actual, already-transferred fees.
    /// @notice The return values let the keeper simulate collection and skip empty transactions.
    function collectFees(address token) external returns (uint256 nativeAmount, uint256 tokenAmount) {
        _known(token);
        uint256 beforeNative = nativeAccounted;
        uint256 beforeTokens = tokens[token].pendingTokens;
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokens[token].positionId;
        feeSplitter.collectFees(ids);
        return (nativeAccounted - beforeNative, tokens[token].pendingTokens - beforeTokens);
    }

    /// @dev Only the fixed FeeSplitter can attribute its actual, already-transferred fees.
    function onAmountsReceived(uint256 positionId, uint256 nativeAmount, uint256 tokenAmount) external nonReentrant {
        if (msg.sender != address(feeSplitter)) revert Unauthorized();
        address token = tokenForPosition[positionId];
        _known(token);
        if (
            address(this).balance < nativeAccounted + nativeAmount
                || IERC20(token).balanceOf(address(this)) < tokens[token].pendingTokens + tokenAmount
        ) revert InvalidAmount();
        _credit(token, nativeAmount, tokenAmount);
    }

    /// @notice Explicit token attribution for additional native USDC fees or donations.
    /// @dev Sending native USDC to an EOA or transferring ERC20-USDC does NOT enroll a token.
    function fundFees(address token) external payable nonReentrant {
        _known(token);
        if (msg.value == 0) revert InvalidAmount();
        _credit(token, msg.value, 0);
    }

    function _credit(address token, uint256 nativeAmount, uint256 tokenAmount) private {
        uint256 project = nativeAmount * 9000 / 10_000;
        uint256 platform = nativeAmount * 700 / 10_000;
        uint256 ops = nativeAmount - project - platform;
        tokens[token].pendingNative += project;
        tokens[token].pendingTokens += tokenAmount;
        if (platformToken == address(0)) unassignedPlatform += platform;
        else tokens[platformToken].pendingNative += platform;
        operationsCredit += ops;
        nativeAccounted += nativeAmount;
        emit FeesReceived(token, nativeAmount, tokenAmount, project, platform, ops);
    }

    /// @notice Permissionless payout to the immutable operations recipient only.
    function claimOperations() external nonReentrant {
        uint256 amount = operationsCredit;
        if (amount == 0) revert InvalidAmount();
        operationsCredit = 0;
        nativeAccounted -= amount;
        (bool success,) = operations.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit OperationsClaimed(amount);
    }

    /// @notice No arbitrary router, recipient or approval supplied by the keeper.
    /// @dev The expected amount protects against a fee credit arriving after the keeper's quote.
    function executeBurn(address token, uint256 expectedNative, uint256 minOut, uint256 deadline)
        external
        nonReentrant
    {
        if (msg.sender != keeper) revert Unauthorized();
        _known(token);
        TokenState storage state = tokens[token];
        if (block.timestamp < state.lastBurnAt + INTERVAL) revert NotDue();
        if (deadline < block.timestamp || deadline > block.timestamp + 120) revert InvalidAmount();
        uint256 amount = state.pendingNative >= minBuyback ? state.pendingNative : 0;
        uint256 feeTokens = state.pendingTokens;
        if (amount != expectedNative || (amount == 0 && feeTokens == 0)) revert InvalidAmount();
        state.pendingNative -= amount;
        state.pendingTokens = 0;
        nativeAccounted -= amount;
        uint256 bought = amount == 0 ? 0 : _swap(token, true, amount, minOut, address(this));
        uint256 reward = token == platformToken && address(rewards) != address(0) ? bought / 10 : 0;
        if (reward != 0) {
            IERC20(token).safeTransfer(address(rewards), reward);
            rewards.credit(reward);
        }
        uint256 burned = bought - reward + feeTokens;
        ArcToken(token).burn(burned);
        state.lastBurnAt = block.timestamp;
        state.totalBuyback += amount;
        state.totalBurned += burned;
        state.cycles++;
        emit Burned(token, amount, bought, feeTokens, burned, state.cycles);
    }

    /// @notice Public native-USDC buy/sell against the same registered V4 pool.
    function trade(address token, bool buy, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        _known(token);
        if (deadline < block.timestamp || deadline > block.timestamp + 120 || msg.value != (buy ? amountIn : 0)) {
            revert InvalidAmount();
        }
        if (!buy) IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
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

    receive() external payable {
        if (msg.sender != address(feeSplitter)) revert Unauthorized();
    }
}
