// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HookVault} from "./HookVault.sol";
import {HookPolicy, IHookFactory} from "./IHookProtocol.sol";

/// Immutable factory/controller. Deploying a vault never changes a token or its original fee recipient.
contract HookVaultFactory is IHookFactory, ReentrancyGuard {
    uint256 public constant DELAY = 48 hours;
    address public immutable admin;
    address public immutable authorizer;
    address public immutable treasury;
    address public immutable implementation;
    bool public paused;
    uint256 public revision;
    mapping(address => bool) public isVault;
    // ERC20 has no standard project-owner field. Registration is explicitly scoped to its creator.
    mapping(address => mapping(address => address)) public vaultOf;
    struct Registration { address implementation; bytes32 codeHash; }
    mapping(bytes32 => Registration) public plugins;
    mapping(address => bytes32) public adapters;
    mapping(bytes32 => uint256) public readyAt;
    event VaultCreated(address indexed owner, address indexed projectToken, address indexed vault, address asset);
    event Scheduled(bytes32 indexed operation, uint256 readyAt);
    event Cancelled(bytes32 indexed operation);
    event PluginRegistered(bytes32 indexed id, address indexed implementation, bytes32 codeHash);
    event AdapterRegistered(address indexed adapter, bytes32 codeHash);
    event GlobalPauseChanged(bool paused, uint256 revision);
    error Invalid();

    constructor(address admin_, address authorizer_, address treasury_) {
        if (admin_ == address(0) || authorizer_ == address(0) || treasury_ == address(0)
            || admin_ == authorizer_) revert Invalid();
        admin = admin_; authorizer = authorizer_; treasury = treasury_;
        implementation = _deployImplementation();
    }
    function _deployImplementation() internal virtual returns (address) {
        return address(new HookVault(IHookFactory(address(this))));
    }
    modifier onlyAdmin() { if (msg.sender != admin) revert Invalid(); _; }
    function plugin(bytes32 id) external view returns (address result) {
        Registration memory r = plugins[id];
        if (r.implementation.code.length == 0 || r.implementation.codehash != r.codeHash) revert Invalid();
        return r.implementation;
    }
    function checkAdapter(address adapter) external view {
        if (adapter.code.length == 0 || adapters[adapter] == bytes32(0) || adapters[adapter] != adapter.codehash) revert Invalid();
    }
    function predictVault(address owner, address projectToken) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, keccak256(abi.encode(owner, projectToken)), address(this));
    }
    function createVault(address projectToken, address asset, HookPolicy[] calldata selected)
        external nonReentrant returns (address vault)
    {
        if (paused || projectToken.code.length == 0 || vaultOf[msg.sender][projectToken] != address(0)) revert Invalid();
        vault = Clones.cloneDeterministic(implementation, keccak256(abi.encode(msg.sender, projectToken)));
        _registerVault(msg.sender, projectToken, vault, asset, selected);
    }
    function _registerVault(address owner, address projectToken, address vault, address asset, HookPolicy[] memory selected) internal {
        if (paused || projectToken.code.length == 0 || vaultOf[owner][projectToken] != address(0) || isVault[vault]) revert Invalid();
        isVault[vault] = true;
        vaultOf[owner][projectToken] = vault;
        HookVault(payable(vault)).initialize(owner, projectToken, asset, selected);
        emit VaultCreated(owner, projectToken, vault, asset);
    }
    function _schedule(bytes32 operation) private returns (bytes32) {
        if (readyAt[operation] != 0) revert Invalid();
        readyAt[operation] = block.timestamp + DELAY;
        emit Scheduled(operation, readyAt[operation]);
        return operation;
    }
    function _consume(bytes32 operation) private {
        uint256 when = readyAt[operation];
        if (when == 0 || block.timestamp < when) revert Invalid();
        delete readyAt[operation];
    }
    function cancel(bytes32 operation) external virtual onlyAdmin {
        delete readyAt[operation]; emit Cancelled(operation);
    }
    function _pluginOperation(bytes32 id, address next) private view returns (bytes32) {
        if (id == bytes32(0) || next.code.length == 0 || next == plugins[id].implementation) revert Invalid();
        return keccak256(abi.encode("plugin", id, next, next.codehash, plugins[id]));
    }
    function schedulePlugin(bytes32 id, address next) external onlyAdmin returns (bytes32) {
        return _schedule(_pluginOperation(id, next));
    }
    function executePlugin(bytes32 id, address next) external {
        _consume(_pluginOperation(id, next));
        plugins[id] = Registration(next, next.codehash);
        ++revision;
        emit PluginRegistered(id, next, next.codehash);
    }
    function _adapterOperation(address next) private view returns (bytes32) {
        if (next.code.length == 0 || adapters[next] == next.codehash) revert Invalid();
        return keccak256(abi.encode("adapter", next, next.codehash, adapters[next]));
    }
    function scheduleAdapter(address next) external onlyAdmin returns (bytes32) {
        return _schedule(_adapterOperation(next));
    }
    function executeAdapter(address next) external {
        _consume(_adapterOperation(next));
        adapters[next] = next.codehash;
        ++revision;
        emit AdapterRegistered(next, next.codehash);
    }
    function _vault(address vault) private view returns (HookVault v) {
        if (!isVault[vault]) revert Invalid();
        return HookVault(payable(vault));
    }
    function _policyOperation(address vault, HookPolicy[] calldata selected) private view returns (bytes32) {
        return keccak256(abi.encode("policy", vault, _vault(vault).revision(), revision, selected));
    }
    function schedulePolicy(address vault, HookPolicy[] calldata selected) external virtual returns (bytes32) {
        if (msg.sender != admin && msg.sender != _vault(vault).owner()) revert Invalid();
        return _schedule(_policyOperation(vault, selected));
    }
    function executePolicy(address vault, HookPolicy[] calldata selected) external virtual nonReentrant {
        _consume(_policyOperation(vault, selected));
        _vault(vault).setPolicies(selected);
    }
    function pauseVault(address vault, bytes32 id) external {
        HookVault v = _vault(vault);
        if (msg.sender != admin && msg.sender != authorizer && msg.sender != v.owner()) revert Invalid();
        v.setPaused(id, true);
    }
    function _resumeOperation(address vault, bytes32 id) private view returns (bytes32) {
        return keccak256(abi.encode("resume", vault, id, _vault(vault).revision(), revision));
    }
    function scheduleResume(address vault, bytes32 id) external returns (bytes32) {
        if (msg.sender != admin && msg.sender != _vault(vault).owner()) revert Invalid();
        return _schedule(_resumeOperation(vault, id));
    }
    function executeResume(address vault, bytes32 id) external {
        _consume(_resumeOperation(vault, id));
        _vault(vault).setPaused(id, false);
    }
    function pause() external {
        if (msg.sender != admin && msg.sender != authorizer) revert Invalid();
        paused = true; emit GlobalPauseChanged(true, ++revision);
    }
    function scheduleGlobalResume() external onlyAdmin returns (bytes32) {
        return _schedule(keccak256(abi.encode("global-resume", revision)));
    }
    function executeGlobalResume() external {
        _consume(keccak256(abi.encode("global-resume", revision)));
        paused = false; emit GlobalPauseChanged(false, ++revision);
    }
}
