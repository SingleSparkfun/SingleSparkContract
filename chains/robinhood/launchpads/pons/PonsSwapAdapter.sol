// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameplayV4Adapter} from "../../../evm/gameplay/adapters/GameplayV4Adapter.sol";
import {IGameplayFactory} from "../../../evm/gameplay/IGameplayProtocol.sol";
import {IPonsLaunch, IPonsCurve} from "./IPonsLaunch.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// One pinned native-ETH route survives Pons graduation; project budgets remain in their Vaults.
contract PonsSwapAdapter is GameplayV4Adapter {
    IPonsLaunch public immutable pons;
    address public immutable hook;
    bytes32 private immutable sourceHash;
    bytes32 private immutable hookHash;
    bytes32 private immutable managerHash;

    constructor(IGameplayFactory factory_, IPonsLaunch pons_)
        GameplayV4Adapter(factory_, IPoolManager(pons_.poolManager()))
    {
        pons = pons_; hook = pons_.memeHook();
        if (hook.code.length == 0) revert Invalid();
        sourceHash = address(pons_).codehash; hookHash = hook.codehash;
        managerHash = address(poolManager).codehash;
    }
    function validate(address assetIn, address assetOut, bytes calldata route) public view override {
        if (address(pons).codehash != sourceHash || hook.codehash != hookHash
            || address(poolManager).codehash != managerHash || pons.memeHook() != hook
            || pons.poolManager() != address(poolManager) || assetIn != address(0) || assetOut == address(0)
            || route.length != 192) revert Invalid();
        IPonsLaunch.LaunchedToken memory launch = pons.getLaunchedToken(assetOut);
        (PoolKey memory key, uint160 limit) = abi.decode(route, (PoolKey, uint160));
        if (!launch.exists || launch.token != assetOut || launch.pairToken != address(0)
            || Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1) != assetOut
            || address(key.hooks) != hook || key.fee != launch.poolFee || key.tickSpacing != launch.tickSpacing
            || limit != 0 || launch.curve.code.length == 0) revert Invalid();
        IPonsCurve curve = IPonsCurve(launch.curve);
        if (curve.token() != assetOut || curve.pairToken() != address(0) || curve.factory() != address(pons)) revert Invalid();
        if (curve.graduated()) super.validate(assetIn, assetOut, route);
    }
    function _executeSwap(address assetIn, address assetOut, uint256 amount, uint256 minimumOutput,
        uint256 deadline, bytes calldata route) internal override returns (uint256 output)
    {
        IPonsCurve curve = IPonsCurve(pons.getLaunchedToken(assetOut).curve);
        if (curve.graduated()) return super._executeSwap(assetIn, assetOut, amount, minimumOutput, deadline, route);
        output = curve.buy{value: amount}(amount, minimumOutput, msg.sender);
        if (output < minimumOutput) revert Invalid();
    }
}
