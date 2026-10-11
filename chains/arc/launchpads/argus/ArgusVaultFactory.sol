// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ArgusRevenueVault, IArgusVaultPortal} from "./ArgusRevenueVault.sol";
import {ArgusCustodyRouter} from "./ArgusCustodyRouter.sol";
import {IRevenuePlugin, BuybackBurnPlugin, PlatformBuybackPlugin, TokenDistributionPlugin} from "./RevenuePlugins.sol";

/// @notice Immutable beacon/controller. Only the shared vault implementation can change, after 48h.
contract ArgusVaultFactory is ReentrancyGuard {
    uint256 public constant DELAY = 48 hours;
    ArgusCustodyRouter public immutable router;
    address public immutable admin;
    address public immutable executor;
    address public implementation;
    address public platformToken;
    uint8 public globalPaused;
    uint256 public revision;
    bytes32 public pending;
    uint256 public readyAt;
    mapping(address => address) public vaultOf;
    mapping(address => bool) public isVault;
    uint8 public pendingKind;
    address public pendingTarget;
    bytes32 public pendingCodeHash;
    uint256 public pendingRevision;
    address[3] public revenuePlugin;
    bytes32[3] public pluginCodeHash;
    uint8 public pendingPluginKind;
    event VaultLaunched(address indexed token, address indexed vault, address indexed initiator, bytes32 salt, string metadataURI);
    event Scheduled(bytes32 indexed operation, uint256 readyAt);
    event Cancelled(bytes32 indexed operation);
    event Paused(address indexed vault, uint8 mask, uint256 revision);
    event Applied(bytes32 indexed operation);
    event PlatformTokenChanged(address indexed previous, address indexed current);
    error Invalid();

    constructor(ArgusCustodyRouter router_, address admin_, address executor_, address implementation_) {
        if (block.chainid != 5042 || address(router_).code.length == 0 || admin_ == address(0)
            || executor_ == address(0) || admin_ == executor_) revert Invalid();
        _checkImplementation(implementation_);
        router = router_; admin = admin_; executor = executor_; implementation = implementation_;
        platformToken = router_.platformToken();
        revenuePlugin = [address(new BuybackBurnPlugin()), address(new PlatformBuybackPlugin()), address(new TokenDistributionPlugin())];
        for (uint8 i; i < 3; ++i) pluginCodeHash[i] = revenuePlugin[i].codehash;
    }
    function _checkImplementation(address next) private view {
        if (next.code.length == 0 || ArgusRevenueVault(payable(next)).layoutVersion() != 2) revert Invalid();
    }
    function _salt(address owner, bytes32 salt) private pure returns (bytes32) { return keccak256(abi.encode(owner, salt)); }
    function predictVault(address owner, bytes32 salt) public view returns (address) {
        bytes32 code = keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(address(this), bytes(""))));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(owner, salt), code)))));
    }
    function launch(IArgusVaultPortal.Params calldata p, IArgusVaultPortal.Meta calldata meta,
        bytes32 salt, bytes32 hookSalt, uint8 plugins, string calldata metadataURI) external nonReentrant returns (address token)
    {
        if (plugins > 7 || bytes(metadataURI).length > 512) revert Invalid();
        address vault = address(new BeaconProxy{salt: _salt(msg.sender, salt)}(address(this), ""));
        ArgusRevenueVault(payable(vault)).initialize(msg.sender, plugins);
        isVault[vault] = true;
        token = ArgusRevenueVault(payable(vault)).launch(p, meta, salt, hookSalt);
        if (vaultOf[token] != address(0)) revert Invalid();
        vaultOf[token] = vault;
        emit VaultLaunched(token, vault, msg.sender, salt, metadataURI);
    }
    function pause(address vault, uint8 mask) external {
        if ((msg.sender != admin && msg.sender != executor) || mask == 0 || mask > 7) revert Invalid();
        if (vault == address(0)) globalPaused |= mask;
        else {
            if (!isVault[vault]) revert Invalid();
            ArgusRevenueVault(payable(vault)).pause(mask);
        }
        ++revision;
        emit Paused(vault, mask, revision);
    }
    function cancel() external {
        if (msg.sender != admin || pending == bytes32(0)) revert Invalid();
        emit Cancelled(pending); _clear();
    }
    function _clear() private {
        pending = bytes32(0); readyAt = 0; pendingKind = 0; pendingTarget = address(0); pendingCodeHash = bytes32(0); pendingRevision = 0; pendingPluginKind = 0;
    }
    function pendingOperation() external view returns (bytes32 operation, uint8 kind, address target, bytes32 codeHash, uint256 ready) {
        return (pending, pendingKind, pendingTarget, pendingCodeHash, readyAt);
    }
    function _schedule(bytes32 operation, uint8 kind, address target) private {
        if (msg.sender != admin || pending != bytes32(0)) revert Invalid();
        pending = operation; readyAt = block.timestamp + DELAY;
        pendingKind = kind; pendingTarget = target; pendingCodeHash = target.codehash;
        pendingRevision = revision;
        emit Scheduled(operation, readyAt);
    }
    function _consume(bytes32 operation) private {
        if (pending == bytes32(0) || pending != operation || block.timestamp < readyAt) revert Invalid();
        _clear(); emit Applied(operation);
    }
    function schedulePolicy(address vault, uint8 plugins, uint16[5] calldata weights) external {
        _policy(vault, plugins, weights);
        _schedule(keccak256(abi.encode(uint8(0), revision, vault, plugins, weights)), 0, vault);
    }
    function executePolicy(address vault, uint8 plugins, uint16[5] calldata weights) external nonReentrant {
        _policy(vault, plugins, weights);
        _consume(keccak256(abi.encode(uint8(0), revision, vault, plugins, weights)));
        ArgusRevenueVault(payable(vault)).setPolicy(plugins, weights);
    }
    function _policy(address vault, uint8 plugins, uint16[5] calldata weights) private view {
        uint256 sum;
        for (uint256 i; i < 5; ++i) sum += weights[i];
        if (!isVault[vault] || plugins > 7 || sum != 10000) revert Invalid();
    }
    function scheduleRevenuePolicy(address vault, uint8 plugins, uint16[6] calldata weights) external {
        _revenuePolicy(vault, plugins, weights);
        _schedule(keccak256(abi.encode(uint8(4), revision, vault, plugins, weights)), 4, vault);
    }
    function schedulePluginWeights(address vault, uint8 plugins, uint16[3] calldata weights) external {
        _pluginWeights(vault, plugins, weights);
        _schedule(keccak256(abi.encode(uint8(5), revision, vault, plugins, weights)), 5, vault);
    }
    function executePluginWeights(address vault, uint8 plugins, uint16[3] calldata weights) external nonReentrant {
        _pluginWeights(vault, plugins, weights);
        _consume(keccak256(abi.encode(uint8(5), revision, vault, plugins, weights)));
        ArgusRevenueVault(payable(vault)).setPluginWeights(plugins, weights);
    }
    function _pluginWeights(address vault, uint8 plugins, uint16[3] calldata weights) private view {
        if (!isVault[vault] || plugins > 7 || !ArgusRevenueVault(payable(vault)).weightedAllocation()) revert Invalid();
        for (uint8 i; i < 3; ++i) if (weights[i] == 0) revert Invalid();
    }
    function schedulePlugin(uint8 kind, address next) external {
        _checkPlugin(kind, next);
        _schedule(keccak256(abi.encode(uint8(6), revision, kind, next, next.codehash)), 6, next);
        pendingPluginKind = kind;
    }
    function executePlugin(uint8 kind, address next) external nonReentrant {
        _checkPlugin(kind, next);
        _consume(keccak256(abi.encode(uint8(6), revision, kind, next, next.codehash)));
        revenuePlugin[kind] = next;
        pluginCodeHash[kind] = next.codehash;
        ++revision;
    }
    function _checkPlugin(uint8 kind, address next) private view {
        if (kind > 2 || next.code.length == 0 || next == revenuePlugin[kind] || IRevenuePlugin(next).kind() != kind) revert Invalid();
    }
    function executeRevenuePolicy(address vault, uint8 plugins, uint16[6] calldata weights) external nonReentrant {
        _revenuePolicy(vault, plugins, weights);
        _consume(keccak256(abi.encode(uint8(4), revision, vault, plugins, weights)));
        ArgusRevenueVault(payable(vault)).setRevenuePolicy(plugins, weights);
    }
    function _revenuePolicy(address vault, uint8 plugins, uint16[6] calldata weights) private view {
        uint256 sum;
        for (uint256 i; i < 6; ++i) sum += weights[i];
        if (!isVault[vault] || plugins > 7 || sum != 10000) revert Invalid();
    }
    function scheduleResume(uint8 mask) external {
        if (mask == 0 || mask > 7) revert Invalid();
        _schedule(keccak256(abi.encode(uint8(1), revision, mask)), 1, address(0));
    }
    function executeResume(uint8 mask) external nonReentrant {
        _consume(keccak256(abi.encode(uint8(1), revision, mask)));
        globalPaused &= ~mask;
    }
    function scheduleUpgrade(address next) external {
        _checkImplementation(next);
        _schedule(keccak256(abi.encode(uint8(2), revision, next, next.codehash)), 2, next);
    }
    function _platformOperation(address next) private view returns (bytes32) {
        if (next == platformToken || next.code.length == 0 || next == address(router.quote())) revert Invalid();
        return keccak256(abi.encode(uint8(3), revision, next, next.codehash, router.poolKey(next)));
    }
    function schedulePlatformToken(address next) external {
        _schedule(_platformOperation(next), 3, next);
    }
    function executePlatformToken(address next) external nonReentrant {
        _consume(_platformOperation(next));
        emit PlatformTokenChanged(platformToken, next);
        platformToken = next;
    }
    function executeUpgrade(address next) external nonReentrant {
        _checkImplementation(next);
        _consume(keccak256(abi.encode(uint8(2), revision, next, next.codehash)));
        implementation = next;
    }
}
