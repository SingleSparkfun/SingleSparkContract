// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameplayVault} from "../../../evm/gameplay/GameplayVault.sol";
import {IGameplayFactory} from "../../../evm/gameplay/IGameplayProtocol.sol";
import {IPonsVaultFactory, IPonsEscrow, IPonsCurve} from "./IPonsLaunch.sol";

/// Pons pays the project contract; callers can collect but cannot choose a recipient.
contract PonsGameplayVault is GameplayVault {
    constructor(IGameplayFactory factory_) GameplayVault(factory_) {}

    function collectRevenue() external nonReentrant {
        IPonsVaultFactory source = IPonsVaultFactory(address(factory));
        source.checkPons();
        IPonsCurve curve = source.curveOf(projectToken);
        if (address(curve) == address(0) || asset != address(0)) revert Invalid();
        if (!curve.graduated()) curve.sweepFees(0);
        IPonsEscrow escrow = source.escrow();
        if (escrow.balanceOf(address(this)) != 0) escrow.claim();
        _sync();
    }
}
