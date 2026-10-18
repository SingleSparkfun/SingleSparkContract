// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HookPolicy, IHookFactory} from "../../../evm/hooks/IHookProtocol.sol";
import {PonsHookVault} from "./PonsHookVault.sol";
import {IPonsLaunch, IPonsVaultFactory} from "./IPonsLaunch.sol";

interface IPonsDelayedFactory {
    function completeActivation(bytes32 operation) external;
}

/// Dev-approved settings become effective by block time; no activation sender or private key is needed.
contract PonsDelayedVault is PonsHookVault {
    bytes32 private activationOperation;
    uint256 private activationTime;
    HookPolicy[] private activationPolicies;

    constructor(IHookFactory factory_) PonsHookVault(factory_) {}

    function initialize(address owner_, address project_, address asset_, HookPolicy[] calldata selected) public override {
        if (selected.length != 0) {
            IPonsVaultFactory source = IPonsVaultFactory(address(factory));
            IPonsLaunch.LaunchedToken memory launch = source.pons().getLaunchedToken(project_);
            if (asset_ != address(0) || !launch.exists || launch.token != project_
                || launch.creatorFeeRecipient != address(this) || launch.curve != address(source.curveOf(project_))) revert Invalid();
        }
        super.initialize(owner_, project_, asset_, selected);
    }
    function pendingActivation() external view returns (bytes32 operation, uint256 effectiveAt, HookPolicy[] memory selected) {
        return (activationOperation, activationTime, activationPolicies);
    }
    function _due() private view returns (bool) { return activationTime != 0 && block.timestamp >= activationTime; }
    function revision() public view override returns (uint256) { return policyRevision + (_due() ? 1 : 0); }
    function policy(bytes32 id) public view override returns (HookPolicy memory p) {
        p = policies[id];
        if (!_due()) return p;
        for (uint256 i; i < activationPolicies.length; ++i) if (activationPolicies[i].id == id) return activationPolicies[i];
        p.weight = 0;
    }
    function pluginIds() public view override returns (bytes32[] memory result) {
        if (!_due()) return ids;
        uint256 count = ids.length;
        for (uint256 i; i < activationPolicies.length; ++i) if (!known[activationPolicies[i].id]) ++count;
        result = new bytes32[](count);
        for (uint256 i; i < ids.length; ++i) result[i] = ids[i];
        count = ids.length;
        for (uint256 i; i < activationPolicies.length; ++i) if (!known[activationPolicies[i].id]) result[count++] = activationPolicies[i].id;
    }
    function unallocated() public view override returns (uint256) {
        if (_due()) for (uint256 i; i < activationPolicies.length; ++i) if (activationPolicies[i].weight != 0) return 0;
        return unallocatedBudget;
    }
    function budget(bytes32 id) public view override returns (uint256 amount) {
        amount = budgets[id];
        if (!_due() || unallocatedBudget == 0) return amount;
        bytes32[] memory selectedIds = pluginIds();
        uint256 total;
        uint256 last;
        for (uint256 i; i < selectedIds.length; ++i) {
            uint256 weight = policy(selectedIds[i]).weight;
            if (weight != 0) { total += weight; last = i; }
        }
        if (total == 0) return amount;
        uint256 remaining = unallocatedBudget;
        for (uint256 i; i < selectedIds.length; ++i) {
            uint256 weight = policy(selectedIds[i]).weight;
            if (weight == 0) continue;
            uint256 share = i == last ? remaining : Math.mulDiv(unallocatedBudget, weight, total);
            if (selectedIds[i] == id) return amount + share;
            remaining -= share;
        }
    }
    function _metadata(HookPolicy memory p) private pure returns (bytes32) {
        return keccak256(abi.encode(p.id, p.targetAsset, p.adapter, p.maxSpend, p.route, p.rules));
    }
    function queueActivation(bytes32 operation, uint256 effectiveAt, HookPolicy[] calldata selected) external onlyFactory nonReentrant {
        _sync();
        if (activationTime != 0 || operation == bytes32(0) || effectiveAt <= block.timestamp) revert Invalid();
        _validatePolicies(selected);
        for (uint256 i; i < selected.length; ++i) {
            // Enable/weight changes never replace a known plugin's spending policy or its inventory asset.
            if (known[selected[i].id] && _metadata(policies[selected[i].id]) != _metadata(selected[i])) revert Invalid();
            activationPolicies.push(selected[i]);
        }
        activationOperation = operation; activationTime = effectiveAt;
        emit PolicyChanged(++policyRevision);
    }
    function cancelActivation() external onlyFactory nonReentrant {
        if (activationTime == 0 || _due()) revert Invalid();
        delete activationOperation; delete activationTime; delete activationPolicies;
        emit PolicyChanged(++policyRevision);
    }
    function setPolicies(HookPolicy[] calldata) external view override onlyFactory { revert Invalid(); }
    function _applyPendingPolicies() internal override {
        if (!_due()) return;
        bool[] memory stopped = new bool[](ids.length);
        for (uint256 i; i < ids.length; ++i) stopped[i] = pluginPaused[ids[i]];
        HookPolicy[] memory selected = activationPolicies;
        bytes32 operation = activationOperation;
        // Registration changes cannot block time-effective allocation or emergency pause; Claim checks current code.
        _writePolicies(selected);
        for (uint256 i; i < stopped.length; ++i) pluginPaused[ids[i]] = stopped[i];
        delete activationOperation; delete activationTime; delete activationPolicies;
        _allocate(0);
        IPonsDelayedFactory(address(factory)).completeActivation(operation);
    }
}
