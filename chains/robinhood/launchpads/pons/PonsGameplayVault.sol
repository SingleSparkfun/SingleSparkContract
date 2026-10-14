// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameplayVault} from "../../../evm/gameplay/GameplayVault.sol";
import {IGameplayFactory} from "../../../evm/gameplay/IGameplayProtocol.sol";
import {IPonsVaultFactory, IPonsEscrow, IPonsCurve, IPonsLaunch, IPonsHook} from "./IPonsLaunch.sol";

/// Pons pays the project contract; callers can collect but cannot choose a recipient.
contract PonsGameplayVault is GameplayVault {
    event PoolRevenueDeferred(bytes32 indexed poolId, address indexed operator);
    error UpstreamFeeSweepRequired(bytes32 poolId, address operator);
    constructor(IGameplayFactory factory_) GameplayVault(factory_) {}

    // Pons permits repeated recipients within and across batches; Claim nonces still prevent authorization replay.
    function permanentPayoutDeduplication() public pure override returns (bool) { return false; }

    function collectRevenue() external nonReentrant {
        IPonsVaultFactory source = IPonsVaultFactory(address(factory));
        source.checkPons();
        IPonsCurve curve = source.curveOf(projectToken);
        if (address(curve) == address(0) || asset != address(0)) revert Invalid();
        bytes32 deferred;
        if (!curve.graduated()) curve.sweepFees(0);
        else {
            (bytes32 poolId, uint256 nativePending,, bool needsOperator) = _poolRevenue(source);
            if (needsOperator) deferred = poolId;
            else if (nativePending != 0) source.hook().sweepPoolFees(poolId, 0, 0);
        }
        IPonsEscrow escrow = source.escrow();
        uint256 claimable = escrow.balanceOf(address(this));
        if (deferred != bytes32(0)) {
            address operator = source.hook().feeSweepOperator();
            if (claimable == 0 && address(this).balance == accounted) revert UpstreamFeeSweepRequired(deferred, operator);
            emit PoolRevenueDeferred(deferred, operator);
        }
        if (claimable != 0) escrow.claim();
        _sync();
    }

    /// Amounts remain upstream until swept; they are not this Vault's spendable budgets.
    function poolRevenue() external view returns (bytes32 poolId, uint256 nativePending, uint256 tokenPending, bool needsOperator) {
        IPonsVaultFactory source = IPonsVaultFactory(address(factory));
        source.checkPons();
        return _poolRevenue(source);
    }

    function _poolRevenue(IPonsVaultFactory source) private view
        returns (bytes32 poolId, uint256 nativePending, uint256 tokenPending, bool needsOperator)
    {
        IPonsLaunch.LaunchedToken memory launch = source.pons().getLaunchedToken(projectToken);
        if (!launch.exists || launch.token != projectToken || launch.curve != address(source.curveOf(projectToken))
            || launch.pairToken != address(0) || launch.creatorFeeRecipient != address(this)) revert Invalid();
        // Graduation and pool creation are separate upstream transactions.
        if (launch.phase != 2) return (bytes32(0), 0, 0, false);
        IPonsHook hook = source.hook();
        poolId = keccak256(abi.encode(address(0), projectToken, launch.poolFee, launch.tickSpacing, address(hook)));
        IPonsHook.LaunchInfo memory info = hook.launches(poolId);
        if (!info.registered || info.memecoinIsCurrency0 || info.memecoin != projectToken
            || info.quoteToken != address(0) || info.creator != address(this)) revert Invalid();
        nativePending = hook.pendingFees(poolId, address(0)) + hook.pendingCreatorTax(poolId, address(0));
        tokenPending = hook.pendingFees(poolId, projectToken) + hook.pendingCreatorTax(poolId, projectToken);
        needsOperator = tokenPending != 0 || hook.pendingBuyback(poolId, address(0)) != 0;
    }
}
