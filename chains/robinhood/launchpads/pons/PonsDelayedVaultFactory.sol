// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookPolicy, IHookFactory} from "../../../evm/hooks/IHookProtocol.sol";
import {IPonsLaunch} from "./IPonsLaunch.sol";
import {PonsVaultFactory} from "./PonsVaultFactory.sol";
import {PonsDelayedVault} from "./PonsDelayedVault.sol";

/// New deployments only; existing factories and Vaults retain their original immutable lifecycle.
contract PonsDelayedVaultFactory is PonsVaultFactory {
    mapping(bytes32 => address) private activationVault;
    address public immutable platformToken;

    constructor(address admin_, address authorizer_, address treasury_, IPonsLaunch pons_, address platformToken_)
        PonsVaultFactory(admin_, authorizer_, treasury_, pons_) {
        if (platformToken_.code.length == 0) revert Invalid();
        platformToken = platformToken_;
    }

    function _deployImplementation() internal override returns (address) {
        return address(new PonsDelayedVault(IHookFactory(address(this))));
    }
    function automaticPolicyActivation() external pure returns (bool) { return true; }
    function initialPluginActivation() external pure returns (bool) { return true; }
    function launchWithPlugins(IPonsLaunch.TokenParams calldata draft, uint32[3] calldata weights, address adapter)
        external payable nonReentrant returns (address token, address curve, address vault)
    {
        (token, curve, vault) = _launch(draft);
        HookPolicy[] memory selected = new HookPolicy[](3);
        bytes32[3] memory ids = [keccak256("buyback-burn@1"), keccak256("platform-buyback@1"), keccak256("distribution@1")];
        for (uint256 i; i < 3; ++i) {
            address target = i == 1 ? platformToken : token;
            selected[i] = HookPolicy(ids[i], weights[i], target, adapter, 100_000_000_000,
                abi.encode(address(0), target, uint24(0), int24(200), address(hook), uint160(0)),
                i == 2 ? abi.encode(uint256(10 ** 19), uint256(100)) : bytes(""));
        }
        _registerVault(msg.sender, token, vault, address(0), selected);
        emit ProjectLaunched(msg.sender, token, vault, curve, draft.salt);
    }
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
