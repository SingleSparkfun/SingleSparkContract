// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHookFactory, IHookSwapAdapter} from "../IHookProtocol.sol";

/// Single-hop, exact-input V4 execution. Native currency settles directly, with no WETH dependency.
contract V4SwapAdapter is IHookSwapAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    IHookFactory public immutable factory;
    IPoolManager public immutable poolManager;
    bytes32 private callbackHash;
    error Invalid();

    constructor(IHookFactory factory_, IPoolManager poolManager_) {
        if (address(factory_).code.length == 0 || address(poolManager_).code.length == 0) revert Invalid();
        factory = factory_; poolManager = poolManager_;
    }
    function validate(address assetIn, address assetOut, bytes calldata route) public view virtual {
        (PoolKey memory key, uint160 limit) = abi.decode(route, (PoolKey, uint160));
        if (route.length != 192 || assetIn == assetOut
            || !((Currency.unwrap(key.currency0) == assetIn && Currency.unwrap(key.currency1) == assetOut)
                || (Currency.unwrap(key.currency0) == assetOut && Currency.unwrap(key.currency1) == assetIn))
            || (limit != 0 && (limit <= TickMath.MIN_SQRT_PRICE || limit >= TickMath.MAX_SQRT_PRICE))) revert Invalid();
        (uint160 price,,,) = poolManager.getSlot0(key.toId());
        if (price == 0) revert Invalid();
    }
    function swap(address assetIn, address assetOut, uint256 amount, uint256 minimumOutput,
        uint256 deadline, bytes calldata route) external payable nonReentrant returns (uint256 output)
    {
        if (!factory.isVault(msg.sender) || amount == 0 || amount > uint256(uint128(type(int128).max))
            || minimumOutput == 0 || deadline < block.timestamp || deadline > block.timestamp + 300) revert Invalid();
        validate(assetIn, assetOut, route);
        if (assetIn == address(0)) {
            if (msg.value != amount) revert Invalid();
        } else {
            if (msg.value != 0) revert Invalid();
            uint256 beforeBalance = IERC20(assetIn).balanceOf(address(this));
            IERC20(assetIn).safeTransferFrom(msg.sender, address(this), amount);
            if (IERC20(assetIn).balanceOf(address(this)) != beforeBalance + amount) revert Invalid();
        }
        return _executeSwap(assetIn, assetOut, amount, minimumOutput, deadline, route);
    }
    function _executeSwap(address assetIn, address, uint256 amount, uint256 minimumOutput,
        uint256, bytes calldata route) internal virtual returns (uint256 output)
    {
        (PoolKey memory key, uint160 limit) = abi.decode(route, (PoolKey, uint160));
        bool zeroForOne = Currency.unwrap(key.currency0) == assetIn;
        if (limit == 0) limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        bytes memory data = abi.encode(msg.sender, key, zeroForOne, amount, limit);
        callbackHash = keccak256(data);
        output = abi.decode(poolManager.unlock(data), (uint256));
        if (callbackHash != bytes32(0) || output < minimumOutput) revert Invalid();
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || callbackHash == bytes32(0) || keccak256(data) != callbackHash) revert Invalid();
        delete callbackHash;
        (address vault, PoolKey memory key, bool zeroForOne, uint256 amount, uint160 limit) =
            abi.decode(data, (address, PoolKey, bool, uint256, uint160));
        BalanceDelta delta = poolManager.swap(key, SwapParams(zeroForOne, -int256(amount), limit), "");
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        int128 got = zeroForOne ? delta.amount1() : delta.amount0();
        if (paid >= 0 || got <= 0 || uint256(-int256(paid)) != amount) revert Invalid();
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        if (Currency.unwrap(input) == address(0)) poolManager.settle{value: amount}();
        else {
            poolManager.sync(input);
            IERC20(Currency.unwrap(input)).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
        poolManager.take(output, vault, uint128(got));
        return abi.encode(uint256(uint128(got)));
    }
}
