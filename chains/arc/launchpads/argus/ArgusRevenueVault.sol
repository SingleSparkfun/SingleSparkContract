// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArgusCustodyRouter} from "./ArgusCustodyRouter.sol";
import {IRevenuePlugin} from "./RevenuePlugins.sol";

interface IArgusVaultPortal {
    struct Params {
        string name; string symbol; uint256 totalSupply; uint256 startFdvUsdc6; uint256 bondFdvUsdc6;
        uint16 buyTaxBps; uint16 sellTaxBps; uint16 creatorBps; uint16 burnBps; uint16 dividendBps;
        uint16 liquidityBps; uint256 devBuyQuote; address quoteAsset; uint8 expectConvert;
    }
    struct Meta { string imageURI; string website; string twitter; string telegram; string description; }
    function launch(Params calldata p, Meta calldata meta, bytes32 salt, bytes32 hookSalt) external returns (address);
}
interface IArgusVaultController {
    function router() external view returns (ArgusCustodyRouter);
    function executor() external view returns (address);
    function platformToken() external view returns (address);
    function globalPaused() external view returns (uint8);
    function revision() external view returns (uint256);
    function implementation() external view returns (address);
    function revenuePlugin(uint256 kind) external view returns (address);
    function pluginCodeHash(uint256 kind) external view returns (bytes32);
}
interface IArgusVaultSplitter {
    function creator() external view returns (address);
    function distribute() external returns (uint256, uint256);
    function claim(address account) external returns (uint256, uint256, uint256);
}
interface IArgusVaultLocker { function collect() external returns (uint256, uint256); }

/// @notice One project owns this proxy's funds and ledger; all proxies share the same implementation.
contract ArgusRevenueVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public constant quote = IERC20(0x3600000000000000000000000000000000000000);
    IArgusVaultController public controller;
    address public initiator;
    address public token;
    address public splitter;
    address public locker;
    uint8 public plugins;
    uint8 public paused;
    uint256[5] public budgets;
    uint16[5] public weights;
    uint256 public accounted;
    uint256 public received;
    uint256 public rewardTokens;
    uint256 public nonce;
    uint256 public totalPaid;
    mapping(address => bool) public paid;
    // Append storage: existing proxies retain their five buckets and original allocation until a delayed policy update.
    uint16 public claimWeight;
    uint256 public claimBudget;
    uint256 public totalClaimPaid;
    uint256 public distributionClaimReward;
    bool public weightedAllocation;
    uint16[3] public pluginWeights;
    uint256 public unallocatedPluginBudget;
    struct PluginTask {
        address implementation; address target; uint8 bucket; uint8 phase;
        uint256 amount; uint256 minimum; uint256 deadline; uint256 output;
        bytes32 recipientsHash;
    }
    PluginTask private activeTask;
    struct Claim {
        address caller; uint8 bucket; address target; uint256 amount; uint256 minimum;
        uint256 deadline; uint256 nonce; uint256 revision; address implementation;
        uint256 reward; bytes32 recipientsHash;
    }
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address caller,uint8 bucket,address target,uint256 amount,uint256 minimum,uint256 deadline,uint256 nonce,uint256 revision,address implementation,uint256 reward,bytes32 recipientsHash)");
    event Income(uint256 amount);
    event Executed(uint256 indexed nonce, uint8 indexed bucket, uint256 amount, uint256 output);
    event PlatformBurned(address indexed token, uint256 quoteUsdc6, uint256 tokens);
    event OwnBurned(address indexed token, uint256 quoteUsdc6, uint256 tokens);
    event Claimed(address indexed caller, uint256 indexed nonce, uint8 indexed bucket, uint256 reward);
    event PluginExecuted(address indexed plugin, uint8 indexed kind, uint256 indexed nonce);
    error Invalid();

    constructor() { controller = IArgusVaultController(address(1)); }
    // Version 2 separates platform buyback; version 1 factories must not reinterpret their masks.
    function layoutVersion() external pure returns (uint256) { return 2; }
    function claimVersion() external pure returns (uint256) { return 1; }
    function allocationVersion() external pure returns (uint256) { return 1; }
    modifier onlyController() { if (msg.sender != address(controller)) revert Invalid(); _; }
    modifier onlyExecutor() { if (msg.sender != controller.executor()) revert Invalid(); _; }

    function initialize(address owner, uint8 selected) public virtual {
        if (address(controller) != address(0) || owner == address(0) || selected > 7) revert Invalid();
        controller = IArgusVaultController(msg.sender);
        initiator = owner;
        plugins = selected;
        weights = [uint16(2984), 2983, 2983, 0, 1000];
        claimWeight = 50;
        weightedAllocation = true;
        pluginWeights = [uint16(1), 1, 1];
    }

    function launch(IArgusVaultPortal.Params calldata p, IArgusVaultPortal.Meta calldata meta,
        bytes32 salt, bytes32 hookSalt) external onlyController nonReentrant returns (address)
    {
        if (token != address(0) || p.quoteAsset != address(quote) || p.creatorBps != 10000
            || p.burnBps != 0 || p.dividendBps != 0 || p.liquidityBps != 0 || p.devBuyQuote != 0
            || p.expectConvert != 1 || p.totalSupply != 1_000_000_000e18
            || p.buyTaxBps > 1000 || p.sellTaxBps > 1000 || p.buyTaxBps % 100 != 0
            || p.sellTaxBps % 100 != 0 || (p.buyTaxBps == 0 && p.sellTaxBps == 0)) revert Invalid();
        ArgusCustodyRouter router = controller.router();
        token = IArgusVaultPortal(address(router.portal())).launch(p, meta, salt, hookSalt);
        (address creator,,,address l,,address s,,,,,) = router.portal().launches(token);
        if (creator != address(this) || IArgusVaultSplitter(s).creator() != address(this)) revert Invalid();
        locker = l;
        splitter = s;
        router.register(token, initiator);
        return token;
    }

    function policy() external view returns (uint8 enabled, uint8 stopped, uint16[5] memory allocation) {
        return (plugins, paused | controller.globalPaused(), weights);
    }
    function ledger() external view returns (uint256[5] memory balances, uint256 inventory,
        uint256 income, uint256 nextNonce, uint256 payouts)
    { return (budgets, rewardTokens, received, nonce, totalPaid); }
    function revenuePolicy() external view returns (uint16[6] memory allocation) {
        for (uint256 i; i < 5; ++i) allocation[i] = weights[i];
        allocation[5] = claimWeight;
    }
    function weightedPolicy() external view returns (bool active, uint16[3] memory relative, uint16 platformBps, uint16 claimBps, uint256 unallocated) {
        return (weightedAllocation, pluginWeights, weights[4], claimWeight, unallocatedPluginBudget);
    }
    function setPluginWeights(uint8 selected, uint16[3] calldata relative) external onlyController nonReentrant {
        if (selected > 7 || !weightedAllocation) revert Invalid();
        for (uint8 i; i < 3; ++i) if (relative[i] == 0) revert Invalid();
        _sync();
        plugins = selected;
        pluginWeights = relative;
        paused = 0;
        ++nonce;
        _allocatePlugins(0);
    }
    function claimState() external view returns (uint256 available, uint256 distributed, uint256 inventoryReward) {
        return (claimBudget, totalClaimPaid, distributionClaimReward);
    }

    function pause(uint8 mask) external onlyController { paused |= mask; }
    function setPolicy(uint8 selected, uint16[5] calldata allocation) external onlyController nonReentrant {
        _setPolicy(selected, allocation, 0);
    }
    function setRevenuePolicy(uint8 selected, uint16[6] calldata allocation) external onlyController nonReentrant {
        uint16[5] memory original;
        for (uint256 i; i < 5; ++i) original[i] = allocation[i];
        _setPolicy(selected, original, allocation[5]);
    }
    function _setPolicy(uint8 selected, uint16[5] memory allocation, uint16 rewardWeight) private {
        if (selected > 7 || weightedAllocation) revert Invalid();
        uint256 sum = rewardWeight;
        for (uint256 i; i < 5; ++i) sum += allocation[i];
        if (sum != 10000) revert Invalid();
        // Book old income before applying new weights; existing buckets never move.
        _sync();
        weights = allocation;
        claimWeight = rewardWeight;
        plugins = selected;
        paused = 0;
        ++nonce;
    }
    function _sync() private {
        if (token == address(0)) revert Invalid();
        uint256 balance = quote.balanceOf(address(this));
        if (balance < accounted) revert Invalid();
        uint256 income = balance - accounted;
        if (income == 0) return;
        if (weightedAllocation) {
            uint256 platformFee = Math.mulDiv(income, weights[4], 10000);
            uint256 reward = Math.mulDiv(income, claimWeight, 10000);
            budgets[4] += platformFee;
            claimBudget += reward;
            _allocatePlugins(income - platformFee - reward);
            accounted = balance;
            received += income;
            emit Income(income);
            return;
        }
        uint256 allocated;
        for (uint256 i; i < 4; ++i) {
            uint256 share = income / 10000 * weights[i] + income % 10000 * weights[i] / 10000;
            budgets[i] += share;
            allocated += share;
        }
        uint256 reward = Math.mulDiv(income, claimWeight, 10000);
        claimBudget += reward;
        budgets[4] += income - allocated - reward;
        accounted = balance;
        received += income;
        emit Income(income);
    }
    function _bit(uint8 bucket) private pure returns (uint8) { return bucket == 2 ? 2 : bucket == 1 ? 4 : 1; }
    function _allocatePlugins(uint256 amount) private {
        amount += unallocatedPluginBudget;
        uint256 total;
        uint8 last;
        for (uint8 i; i < 3; ++i) if (plugins & _bit(i) != 0) { total += pluginWeights[i]; last = i; }
        if (total == 0) { unallocatedPluginBudget = amount; return; }
        unallocatedPluginBudget = 0;
        uint256 remaining = amount;
        for (uint8 i; i < 3; ++i) if (plugins & _bit(i) != 0) {
            uint256 share = i == last ? remaining : Math.mulDiv(amount, pluginWeights[i], total);
            budgets[i] += share;
            remaining -= share;
        }
    }
    function collect() external nonReentrant {
        if (token == address(0)) revert Invalid();
        IArgusVaultLocker(locker).collect();
        IArgusVaultSplitter(splitter).distribute();
        IArgusVaultSplitter(splitter).claim(address(this));
        _sync();
    }
    function sync() external nonReentrant { _sync(); }

    function _enabled(uint8 bit, uint256 expectedNonce) private {
        if (expectedNonce != nonce || plugins & bit == 0 || (paused | controller.globalPaused()) & bit != 0) revert Invalid();
        ++nonce;
    }
    function _debit(uint8 bucket, uint256 amount) private {
        if (amount == 0 || amount > budgets[bucket]) revert Invalid();
        budgets[bucket] -= amount;
        accounted -= amount;
    }
    function buy(uint8 bucket, uint256 amount, uint256 minimum, uint256 deadline, uint256 expectedNonce)
        external onlyExecutor nonReentrant
    {
        if (bucket == 1) revert Invalid();
        _buy(bucket, token, amount, minimum, deadline, expectedNonce);
    }
    function buyPlatform(address expectedToken, uint256 amount, uint256 minimum, uint256 deadline, uint256 expectedNonce)
        external onlyExecutor nonReentrant
    {
        if (expectedToken != controller.platformToken()) revert Invalid();
        _buy(1, expectedToken, amount, minimum, deadline, expectedNonce);
    }
    function _buy(uint8 bucket, address target, uint256 amount, uint256 minimum, uint256 deadline, uint256 expectedNonce) private {
        if (bucket > 2 || minimum == 0 || deadline < block.timestamp || deadline > block.timestamp + 30) revert Invalid();
        _enabled(_bit(bucket), expectedNonce);
        _sync();
        if (weightedAllocation) {
            _executePlugin(bucket, target, amount, minimum, deadline, expectedNonce, new address[](0));
            return;
        }
        _debit(bucket, amount);
        ArgusCustodyRouter router = controller.router();
        uint256 beforeQuote = quote.balanceOf(address(this));
        uint256 beforeTokens = IERC20(token).balanceOf(address(this));
        quote.forceApprove(address(router), amount);
        uint256 output;
        if (bucket == 2) {
            output = router.trade(token, true, amount * 1e12, minimum, deadline);
            if (IERC20(token).balanceOf(address(this)) - beforeTokens != output) revert Invalid();
            rewardTokens += output;
            distributionClaimReward += claimRewardLimit(amount);
        } else if (bucket == 1) {
            uint256 beforeTarget = IERC20(target).balanceOf(address(this));
            output = router.trade(target, true, amount * 1e12, minimum, deadline);
            if (IERC20(target).balanceOf(address(this)) - beforeTarget != output) revert Invalid();
            uint256 beforeBurn = IERC20(target).balanceOf(address(0xdead));
            IERC20(target).safeTransfer(address(0xdead), output);
            if (IERC20(target).balanceOf(address(0xdead)) - beforeBurn != output) revert Invalid();
            emit PlatformBurned(target, amount, output);
        } else {
            output = router.buyAndBurn(target, amount, minimum, deadline);
        }
        quote.forceApprove(address(router), 0);
        if (beforeQuote - quote.balanceOf(address(this)) != amount) revert Invalid();
        emit Executed(expectedNonce, bucket, amount, output);
    }
    function distribute(uint256 expectedNonce, address[] calldata recipients) external onlyExecutor nonReentrant {
        _distribute(expectedNonce, recipients);
    }
    function _distribute(uint256 expectedNonce, address[] calldata recipients) private returns (uint256 reward) {
        _enabled(2, expectedNonce);
        if (weightedAllocation) {
            return _executePlugin(5, token, 0, 0, 0, expectedNonce, recipients);
        }
        return _distributeInventory(expectedNonce, recipients);
    }
    function _distributeInventory(uint256 expectedNonce, address[] calldata recipients) private returns (uint256 reward) {
        uint256 amount = recipients.length * 10e18;
        if (recipients.length < 100 || amount > rewardTokens) revert Invalid();
        for (uint256 i; i < recipients.length; ++i) {
            if (paid[recipients[i]]) revert Invalid();
            paid[recipients[i]] = true;
        }
        reward = Math.mulDiv(distributionClaimReward, amount, rewardTokens);
        distributionClaimReward -= reward;
        rewardTokens -= amount;
        ArgusCustodyRouter router = controller.router();
        IERC20(token).forceApprove(address(router), amount);
        router.distribute(token, totalPaid, recipients);
        IERC20(token).forceApprove(address(router), 0);
        totalPaid += recipients.length;
        emit Executed(expectedNonce, 5, amount, recipients.length);
    }
    /// Each spent quote unit earns once; inventory purchases reserve the reward until actual distribution.
    function claimRewardLimit(uint256 amount) public view returns (uint256) {
        uint256 workWeight = weightedAllocation ? 10000 - uint256(weights[4]) - claimWeight : uint256(weights[0]) + weights[1] + weights[2];
        if (workWeight == 0) return 0;
        return Math.min(Math.mulDiv(amount, claimWeight, workWeight), claimBudget - distributionClaimReward);
    }
    function _executePlugin(uint8 bucket, address target, uint256 amount, uint256 minimum,
        uint256 deadline, uint256 expectedNonce, address[] memory recipients) private returns (uint256 result)
    {
        uint8 kind = bucket == 5 ? 2 : bucket;
        address plugin = controller.revenuePlugin(kind);
        if (plugin.code.length == 0 || plugin.codehash != controller.pluginCodeHash(kind)
            || IRevenuePlugin(plugin).kind() != kind || activeTask.implementation != address(0)) revert Invalid();
        activeTask = PluginTask(plugin, target, bucket, 0, amount, minimum, deadline, 0, keccak256(abi.encode(recipients)));
        IRevenuePlugin(plugin).execute(bucket == 5, recipients);
        if (activeTask.phase != 2) revert Invalid();
        result = activeTask.output;
        if (bucket != 5) emit Executed(expectedNonce, bucket, amount, result);
        delete activeTask;
        emit PluginExecuted(plugin, kind, expectedNonce);
    }
    modifier onlyActivePlugin(uint8 phase) {
        if (msg.sender != activeTask.implementation || activeTask.phase != phase) revert Invalid();
        _;
    }
    function pluginSwap() external onlyActivePlugin(0) returns (uint256 output) {
        PluginTask storage task = activeTask;
        if (task.bucket > 2) revert Invalid();
        task.phase = 1;
        _debit(task.bucket, task.amount);
        ArgusCustodyRouter router = controller.router();
        // Preserve the router's pool/window cap even though the plugin chooses its gameplay.
        uint256 beforeQuote = quote.balanceOf(address(this));
        uint256 beforeTokens = IERC20(task.target).balanceOf(address(this));
        quote.forceApprove(address(router), task.amount);
        output = router.trade(task.target, true, task.amount * 1e12, task.minimum, task.deadline);
        quote.forceApprove(address(router), 0);
        if (beforeQuote - quote.balanceOf(address(this)) != task.amount
            || IERC20(task.target).balanceOf(address(this)) - beforeTokens != output) revert Invalid();
        task.output = output;
    }
    function pluginBurn(uint256 amount) external onlyActivePlugin(1) {
        PluginTask storage task = activeTask;
        if (task.bucket > 1 || amount != task.output) revert Invalid();
        task.phase = 2;
        IERC20 asset = IERC20(task.target);
        uint256 beforeBurn = asset.balanceOf(address(0xdead));
        asset.safeTransfer(address(0xdead), amount);
        if (asset.balanceOf(address(0xdead)) - beforeBurn != amount) revert Invalid();
        if (task.bucket == 1) emit PlatformBurned(task.target, task.amount, amount);
        else emit OwnBurned(task.target, task.amount, amount);
    }
    function pluginInventory(uint256 amount) external onlyActivePlugin(1) {
        if (activeTask.bucket != 2 || amount != activeTask.output) revert Invalid();
        activeTask.phase = 2;
        rewardTokens += amount;
        distributionClaimReward += claimRewardLimit(activeTask.amount);
    }
    function pluginDistribute(address[] calldata recipients) external onlyActivePlugin(0) {
        if (activeTask.bucket != 5 || keccak256(abi.encode(recipients)) != activeTask.recipientsHash) revert Invalid();
        activeTask.phase = 2;
        activeTask.output = _distributeInventory(nonce - 1, recipients);
    }
    function claimDigest(Claim calldata request) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SingleSpark Argus Claim"), keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(CLAIM_TYPEHASH, request))));
    }
    function claim(Claim calldata request, address[] calldata recipients, bytes calldata signature) external nonReentrant {
        if (request.caller != msg.sender || request.deadline < block.timestamp || request.deadline > block.timestamp + 30
            || request.revision != controller.revision() || request.implementation != controller.implementation()
            || request.recipientsHash != keccak256(abi.encode(recipients))
            || ECDSA.recover(claimDigest(request), signature) != controller.executor()) revert Invalid();
        uint256 limit;
        if (request.bucket == 5) {
            if (request.target != token || request.amount != 0 || request.minimum != 0) revert Invalid();
            limit = _distribute(request.nonce, recipients);
        } else {
            address target = request.bucket == 1 ? controller.platformToken() : token;
            if (recipients.length != 0 || request.target != target) revert Invalid();
            _sync();
            limit = request.bucket == 2 ? 0 : claimRewardLimit(request.amount);
            _buy(request.bucket, target, request.amount, request.minimum, request.deadline, request.nonce);
        }
        if (request.reward > limit || request.reward > claimBudget) revert Invalid();
        if (request.reward != 0) {
            claimBudget -= request.reward;
            accounted -= request.reward;
            totalClaimPaid += request.reward;
            quote.safeTransfer(msg.sender, request.reward);
        }
        emit Claimed(msg.sender, request.nonce, request.bucket, request.reward);
    }
    /// Fixed treasury recipients only; no administrator or keeper withdrawal destination.
    function settle(bool platform, uint256 amount) external nonReentrant {
        ArgusCustodyRouter router = controller.router();
        if (!platform && !router.governanceEnabled()) revert Invalid();
        _sync();
        uint8 bucket = platform ? 4 : 3;
        _debit(bucket, amount);
        quote.forceApprove(address(router), amount);
        router.fundTreasury(token, platform, amount);
        quote.forceApprove(address(router), 0);
        emit Executed(nonce++, bucket, amount, 0);
    }
    receive() external payable {}
}
