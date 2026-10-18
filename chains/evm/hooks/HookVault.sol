// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HookAsset} from "./HookAsset.sol";
import {HookPolicy, HookClaim, IHookFactory, IHookPlugin, IHookSwapAdapter, IHookVault} from "./IHookProtocol.sol";

/// Single project, single funding asset. Plugins operate bounded callbacks, never hold project budgets.
contract HookVault is ReentrancyGuard, IHookVault {
    using SafeERC20 for IERC20;
    IHookFactory public immutable factory;
    address public owner;
    address public projectToken;
    address public asset;
    bool public paused;
    uint256 internal policyRevision;
    uint256 public nonce;
    uint256 public accounted;
    uint256 public received;
    uint256 public platformBudget;
    uint256 public claimBudget;
    uint256 public reservedClaim;
    uint256 internal unallocatedBudget;
    bytes32[] internal ids;
    mapping(bytes32 => bool) internal known;
    mapping(bytes32 => HookPolicy) internal policies;
    mapping(bytes32 => bool) public pluginPaused;
    mapping(bytes32 => uint256) internal budgets;
    mapping(bytes32 => uint256) public inventory;
    mapping(bytes32 => uint256) public inventoryReward;
    mapping(address => bool) public paid;
    struct Active {
        bytes32 id; address implementation; uint8 phase; uint256 amount;
        uint256 minimumOutput; uint256 deadline; uint256 output; uint256 reward;
    }
    Active private active;
    uint16 private allocationRemainder;
    // Preserve the deployed EIP-712 wire identity after the Hook source rename.
    bytes32 public constant CLAIM_TYPEHASH = keccak256("GameplayClaim(address caller,bytes32 pluginId,uint256 amount,uint256 minimumOutput,uint256 reward,uint256 deadline,uint256 nonce,uint256 policyRevision,uint256 registryRevision,bytes32 dataHash)");
    event Income(uint256 amount);
    event Deposited(address indexed sender, uint256 amount);
    event PolicyChanged(uint256 revision);
    event PauseChanged(bytes32 indexed pluginId, bool paused, uint256 revision);
    event Executed(bytes32 indexed pluginId, address indexed caller, uint256 indexed nonce, uint256 spent, uint256 reward);
    event Acquired(bytes32 indexed pluginId, address indexed targetAsset, uint256 spent, uint256 output);
    event Burned(bytes32 indexed pluginId, address indexed targetAsset, uint256 amount);
    event Paid(bytes32 indexed pluginId, address indexed targetAsset, address indexed recipient, uint256 amount);
    event PlatformSettled(uint256 amount);
    error Invalid();

    constructor(IHookFactory factory_) { factory = factory_; owner = address(1); }
    modifier onlyFactory() { if (msg.sender != address(factory)) revert Invalid(); _; }
    modifier onlyPlugin(uint8 phase) {
        if (msg.sender != active.implementation || active.phase != phase || active.implementation == address(0)) revert Invalid();
        _;
    }

    function initialize(address owner_, address project_, address asset_, HookPolicy[] calldata selected) public virtual onlyFactory {
        if (owner != address(0) || owner_ == address(0) || project_.code.length == 0
            || (asset_ != address(0) && asset_.code.length == 0)) revert Invalid();
        owner = owner_; projectToken = project_; asset = asset_;
        _setPolicies(selected);
    }

    function revision() public view virtual returns (uint256) { return policyRevision; }
    function budget(bytes32 id) public view virtual returns (uint256) { return budgets[id]; }
    function unallocated() public view virtual returns (uint256) { return unallocatedBudget; }
    function pluginIds() public view virtual returns (bytes32[] memory) { return ids; }
    function permanentPayoutDeduplication() public pure virtual returns (bool) { return true; }
    function policy(bytes32 id) public view virtual returns (HookPolicy memory) { return policies[id]; }
    function activePolicy() external view returns (HookPolicy memory) {
        if (active.implementation == address(0)) revert Invalid();
        return policies[active.id];
    }
    function setPolicies(HookPolicy[] calldata selected) external virtual onlyFactory nonReentrant {
        _sync();
        _setPolicies(selected);
        // Unallocated funds have no prior plugin owner. Existing plugin balances never move.
        _allocate(0);
    }
    function _validatePolicies(HookPolicy[] memory selected) internal view {
        if (selected.length > 16) revert Invalid();
        uint256 count = ids.length;
        for (uint256 i; i < selected.length; ++i) {
            HookPolicy memory p = selected[i];
            if (p.id == bytes32(0) || p.route.length > 4096 || p.rules.length > 4096
                || (p.targetAsset != address(0) && p.targetAsset.code.length == 0)) revert Invalid();
            for (uint256 j; j < i; ++j) if (selected[j].id == p.id) revert Invalid();
            if (inventory[p.id] != 0 && policies[p.id].targetAsset != p.targetAsset) revert Invalid();
            address implementation = factory.plugin(p.id);
            IHookPlugin(implementation).validate(projectToken, asset, p);
            if (p.targetAsset != asset) {
                factory.checkAdapter(p.adapter);
                IHookSwapAdapter(p.adapter).validate(asset, p.targetAsset, p.route);
            } else if (p.adapter != address(0) || p.route.length != 0) revert Invalid();
            if (!known[p.id]) ++count;
            if (count > 16) revert Invalid();
        }
    }
    function _setPolicies(HookPolicy[] memory selected) internal {
        _validatePolicies(selected);
        _writePolicies(selected);
    }
    function _writePolicies(HookPolicy[] memory selected) internal {
        for (uint256 i; i < ids.length; ++i) policies[ids[i]].weight = 0;
        for (uint256 i; i < selected.length; ++i) {
            HookPolicy memory p = selected[i];
            if (!known[p.id]) { known[p.id] = true; ids.push(p.id); }
            policies[p.id] = p;
            pluginPaused[p.id] = false;
        }
        emit PolicyChanged(++policyRevision);
    }
    function _applyPendingPolicies() internal virtual {}
    function setPaused(bytes32 id, bool stopped) external onlyFactory {
        _applyPendingPolicies();
        if (id == bytes32(0)) paused = stopped;
        else {
            if (!known[id]) revert Invalid();
            pluginPaused[id] = stopped;
        }
        emit PauseChanged(id, stopped, ++policyRevision);
    }

    /// Approval is required for ERC20 deposits. Direct transfers are recognized by sync().
    function deposit(uint256 amount) external payable nonReentrant returns (uint256 credited) {
        if (amount == 0) revert Invalid();
        if (asset == address(0)) {
            if (msg.value != amount) revert Invalid();
            credited = amount;
        } else {
            if (msg.value != 0) revert Invalid();
            uint256 beforeBalance = HookAsset.balance(asset, address(this));
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
            credited = HookAsset.balance(asset, address(this)) - beforeBalance;
            if (credited != amount) revert Invalid();
        }
        _sync();
        emit Deposited(msg.sender, credited);
    }
    function sync() external nonReentrant { _sync(); }
    function _sync() internal {
        if (owner == address(0)) revert Invalid();
        _applyPendingPolicies();
        uint256 balance = HookAsset.balance(asset, address(this));
        if (balance < accounted) revert Invalid();
        uint256 income = balance - accounted;
        if (income == 0) return;
        uint256 base = income + allocationRemainder;
        uint256 fee = Math.mulDiv(base, 1000, 10000) - uint256(allocationRemainder) * 1000 / 10000;
        uint256 reward = Math.mulDiv(base, 50, 10000) - uint256(allocationRemainder) * 50 / 10000;
        uint256 work = Math.mulDiv(base, 8950, 10000) - uint256(allocationRemainder) * 8950 / 10000;
        allocationRemainder = uint16(base % 10000);
        platformBudget += fee;
        claimBudget += reward;
        _allocate(work);
        accounted = balance;
        received += income;
        emit Income(income);
    }
    /// Fractional allocations stay backed by unspendable funding units until later income completes them.
    function roundingReserve() external view returns (uint256) {
        uint256 base = allocationRemainder;
        return base - base * 1000 / 10000 - base * 50 / 10000 - base * 8950 / 10000;
    }
    function _allocate(uint256 amount) internal {
        amount += unallocatedBudget;
        uint256 totalWeight;
        uint256 last;
        for (uint256 i; i < ids.length; ++i) if (policies[ids[i]].weight != 0) {
            totalWeight += policies[ids[i]].weight; last = i;
        }
        if (totalWeight == 0) { unallocatedBudget = amount; return; }
        unallocatedBudget = 0;
        uint256 remaining = amount;
        for (uint256 i; i < ids.length; ++i) if (policies[ids[i]].weight != 0) {
            uint256 share = i == last ? remaining : Math.mulDiv(amount, policies[ids[i]].weight, totalWeight);
            budgets[ids[i]] += share; remaining -= share;
        }
    }
    function settlePlatform() external nonReentrant {
        _sync();
        uint256 amount = platformBudget;
        if (amount == 0) return;
        platformBudget = 0; accounted -= amount;
        HookAsset.send(asset, factory.treasury(), amount);
        emit PlatformSettled(amount);
    }

    function claimDigest(HookClaim calldata request) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SingleSpark Gameplay"), keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(CLAIM_TYPEHASH, request))));
    }
    function claim(HookClaim calldata request, bytes calldata data, bytes calldata signature) external nonReentrant {
        _applyPendingPolicies();
        HookPolicy storage p = policies[request.pluginId];
        if (paused || factory.paused() || pluginPaused[request.pluginId] || p.weight == 0
            || request.caller != msg.sender || request.nonce != nonce || request.policyRevision != revision()
            || request.registryRevision != factory.revision() || request.deadline < block.timestamp
            || request.deadline > block.timestamp + 300 || request.dataHash != keccak256(data)
            || request.amount > p.maxSpend || ECDSA.recover(claimDigest(request), signature) != factory.authorizer()) revert Invalid();
        _sync();
        ++nonce;
        active = Active(request.pluginId, factory.plugin(request.pluginId), 0, request.amount,
            request.minimumOutput, request.deadline, 0, 0);
        IHookPlugin(active.implementation).validate(projectToken, asset, p);
        IHookPlugin(active.implementation).execute(data);
        if (active.phase != 2 || request.reward > active.reward || request.reward > claimBudget - reservedClaim
            || request.policyRevision != revision() || request.registryRevision != factory.revision()) revert Invalid();
        delete active;
        if (request.reward != 0) {
            claimBudget -= request.reward; accounted -= request.reward;
            HookAsset.send(asset, msg.sender, request.reward);
        }
        emit Executed(request.pluginId, msg.sender, request.nonce, request.amount, request.reward);
    }

    /// If the plugin spends its funding asset directly, no exchange or wrapping is needed.
    function pluginAcquire() external onlyPlugin(0) returns (uint256 output) {
        HookPolicy storage p = policies[active.id];
        uint256 amount = active.amount;
        if (amount == 0 || amount > budgets[active.id] || active.minimumOutput == 0) revert Invalid();
        active.phase = 1;
        budgets[active.id] -= amount;
        if (p.targetAsset == asset) {
            output = amount;
            if (output < active.minimumOutput) revert Invalid();
        } else {
            factory.checkAdapter(p.adapter);
            uint256 beforeInput = HookAsset.balance(asset, address(this));
            uint256 beforeOutput = HookAsset.balance(p.targetAsset, address(this));
            accounted -= amount;
            if (asset != address(0)) IERC20(asset).forceApprove(p.adapter, amount);
            output = IHookSwapAdapter(p.adapter).swap{value: asset == address(0) ? amount : 0}(
                asset, p.targetAsset, amount, active.minimumOutput, active.deadline, p.route);
            if (asset != address(0)) IERC20(asset).forceApprove(p.adapter, 0);
            if (HookAsset.balance(asset, address(this)) + amount != beforeInput
                || HookAsset.balance(p.targetAsset, address(this)) != beforeOutput + output
                || output < active.minimumOutput) revert Invalid();
        }
        active.output = output;
        emit Acquired(active.id, p.targetAsset, amount, output);
    }
    function _reward(uint256 spent) private view returns (uint256) {
        return Math.min(Math.mulDiv(spent, 50, 8950), claimBudget - reservedClaim);
    }
    function pluginBurn() external onlyPlugin(1) {
        active.phase = 2;
        address target = policies[active.id].targetAsset;
        if (target == asset) accounted -= active.output;
        active.reward = _reward(active.amount);
        HookAsset.send(target, address(0xdead), active.output);
        emit Burned(active.id, target, active.output);
    }
    function pluginStore() external onlyPlugin(1) {
        active.phase = 2;
        inventory[active.id] += active.output;
        uint256 reward = _reward(active.amount);
        inventoryReward[active.id] += reward;
        reservedClaim += reward;
    }
    function pluginDistribute(address[] calldata recipients, uint256 amountPerRecipient) external onlyPlugin(0) {
        if (active.amount != 0 || active.minimumOutput != 0 || amountPerRecipient == 0
            || recipients.length == 0 || recipients.length > 200) revert Invalid();
        uint256 amount = recipients.length * amountPerRecipient;
        uint256 available = inventory[active.id];
        if (amount > available) revert Invalid();
        active.phase = 2;
        active.reward = Math.mulDiv(inventoryReward[active.id], amount, available);
        inventoryReward[active.id] -= active.reward;
        reservedClaim -= active.reward;
        inventory[active.id] -= amount;
        address target = policies[active.id].targetAsset;
        if (target == asset) accounted -= amount;
        bool permanent = permanentPayoutDeduplication();
        address previous;
        for (uint256 i; i < recipients.length; ++i) {
            address to = recipients[i];
            if (to == address(0) || to < previous || (permanent && to == previous)
                || to == address(this) || to == address(factory) || to == target
                || to == address(0xdead) || factory.isVault(to)) revert Invalid();
            previous = to;
            if (permanent) {
                if (paid[to]) revert Invalid();
                paid[to] = true;
            }
            HookAsset.send(target, to, amountPerRecipient);
            emit Paid(active.id, target, to, amountPerRecipient);
        }
    }

    receive() external payable {
        if (asset != address(0) && !(active.implementation != address(0)
            && active.phase == 1 && policies[active.id].targetAsset == address(0))) revert Invalid();
    }
}
