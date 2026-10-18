// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookPolicy, IHookFactory} from "../../../evm/hooks/IHookProtocol.sol";
import {IPonsLaunch} from "./IPonsLaunch.sol";
import {PonsVaultFactory} from "./PonsVaultFactory.sol";
import {PonsDelayedVault} from "./PonsDelayedVault.sol";

/// New deployments only; existing factories and Vaults retain their original immutable lifecycle.
contract PonsDelayedVaultFactory is PonsVaultFactory {
    mapping(bytes32 => address) private activationVault;

    constructor(address admin_, address authorizer_, address treasury_, IPonsLaunch pons_)
        PonsVaultFactory(admin_, authorizer_, treasury_, pons_) {}

    function _deployImplementation() internal override returns (address) {
        return address(new PonsDelayedVault(IHookFactory(address(this))));
    }
    function automaticPolicyActivation() external pure returns (bool) { return true; }
    function activatePlugins(address vault, HookPolicy[] calldata selected) external nonReentrant returns (bytes32 operation) {
        if (!isVault[vault] || msg.sender != PonsDelayedVault(payable(vault)).owner()) revert Invalid();
        operation = keccak256(abi.encode("activate-plugins", vault, PonsDelayedVault(payable(vault)).revision(), revision, selected));
        if (readyAt[operation] != 0) revert Invalid();
        uint256 effectiveAt = block.timestamp + DELAY;
        readyAt[operation] = effectiveAt; activationVault[operation] = vault;
        PonsDelayedVault(payable(vault)).queueActivation(operation, effectiveAt, selected);
        emit Scheduled(operation, effectiveAt);
    }
    function completeActivation(bytes32 operation) external {
        if (!isVault[msg.sender] || activationVault[operation] != msg.sender) revert Invalid();
        delete activationVault[operation]; delete readyAt[operation];
    }
    function cancel(bytes32 operation) external override onlyAdmin {
        address vault = activationVault[operation];
        if (vault != address(0)) PonsDelayedVault(payable(vault)).cancelActivation();
        delete activationVault[operation]; delete readyAt[operation];
        emit Cancelled(operation);
    }
    function schedulePolicy(address, HookPolicy[] calldata) external pure override returns (bytes32) { revert Invalid(); }
    function executePolicy(address, HookPolicy[] calldata) external pure override { revert Invalid(); }
}
