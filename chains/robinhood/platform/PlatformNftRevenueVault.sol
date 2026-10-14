// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPlatformNft, IPlatformNftController} from "./IPlatformNft.sol";

/// Platform-owned native fee income only. Existing project/plugin budgets never enter this ledger.
contract PlatformNftRevenueVault is IERC721Receiver, ReentrancyGuard {
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant DELAY = 48 hours;
    uint256 public constant MAX_BATCH = 32;
    address public immutable owner;
    IPlatformNft public immutable nft;
    IPlatformNftController public immutable controller;
    uint256 public immutable genesis;
    uint256 public totalReceived;
    uint256 public ownerCredit;
    uint256 public nftReserve;
    uint256 public totalOwnerClaimed;
    uint256 public totalNftClaimed;
    uint256 public accountedBalance;
    bool public paused;
    uint256 public resumeAfter;
    mapping(uint256 => uint256) public epochRevenue;
    mapping(uint256 => uint256) public epochPaid;
    mapping(address => mapping(uint256 => bool)) public epochClaimed;
    struct Stake { address account; uint16 weight; }
    mapping(uint256 => Stake) public stakeOf;
    mapping(address => uint256[]) private _tokens;
    mapping(uint256 => uint256) private _tokenIndex;
    struct Checkpoint { uint256 time; uint256 weight; uint256 integral; }
    Checkpoint[] private _total;
    mapping(address => Checkpoint[]) private _accounts;
    error Invalid();
    error Unauthorized();
    error NotReady();
    error NothingToClaim();
    error TransferFailed();
    event Income(uint256 indexed epoch, uint256 amount, uint256 ownerAmount, uint256 nftAmount);
    event OwnerClaimed(address indexed owner, uint256 amount);
    event RewardsClaimed(address indexed account, address indexed recipient, uint256 amount);
    event EpochClaimed(address indexed account, uint256 indexed epoch, uint256 amount);
    event Staked(address indexed account, uint256 indexed tokenId, uint256 weight);
    event Unstaked(address indexed account, uint256 indexed tokenId);
    event EmptyEpochRolled(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount);
    event PauseChanged(bool paused, uint256 resumeAfter);

    constructor(address owner_, IPlatformNft nft_, IPlatformNftController controller_) {
        if (block.chainid != 46630 || owner_ == address(0) || address(nft_).code.length == 0
            || address(controller_) != msg.sender) revert Invalid();
        owner = owner_; nft = nft_; controller = controller_; genesis = block.timestamp;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    receive() external payable nonReentrant { _sync(); }
    function deposit() external payable nonReentrant { _sync(); }
    /// Accounts for forced native transfers exactly once; no caller chooses their destination.
    function sync() external nonReentrant { _sync(); }
    function _sync() private {
        uint256 income = address(this).balance - accountedBalance;
        if (income == 0) return;
        // Cumulative rounding preserves an exact 50% owner share even across one-wei deposits.
        uint256 ownerAmount = (totalReceived + income) / 2 - totalReceived / 2;
        totalReceived += income; accountedBalance += income;
        ownerCredit += ownerAmount; nftReserve += income - ownerAmount;
        uint256 epoch = currentEpoch();
        epochRevenue[epoch] += income - ownerAmount;
        emit Income(epoch, income, ownerAmount, income - ownerAmount);
    }
    function currentEpoch() public view returns (uint256) { return (block.timestamp - genesis) / EPOCH_DURATION; }
    function epochStart(uint256 epoch) public view returns (uint256) { return genesis + epoch * EPOCH_DURATION; }
    function qualityWeight(uint8 quality) public view virtual returns (uint16) {
        if (quality == 1) return 100;
        if (quality == 2) return 150;
        if (quality == 3) return 200;
        if (quality == 4) return 300;
        revert Invalid();
    }
    function stake(uint256[] calldata tokenIds) external nonReentrant {
        if (paused || controller.paused() || tokenIds.length == 0 || tokenIds.length > MAX_BATCH) revert Invalid();
        uint256 added;
        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i];
            if (stakeOf[id].account != address(0) || nft.ownerOf(id) != msg.sender) revert Unauthorized();
            uint16 weight = qualityWeight(nft.qualityOf(id));
            stakeOf[id] = Stake(msg.sender, weight);
            _tokenIndex[id] = _tokens[msg.sender].length;
            _tokens[msg.sender].push(id); added += weight;
            nft.safeTransferFrom(msg.sender, address(this), id);
            emit Staked(msg.sender, id, weight);
        }
        _checkpoint(_accounts[msg.sender], added, true);
        _checkpoint(_total, added, true);
    }
    function unstake(uint256[] calldata tokenIds, address recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this) || tokenIds.length == 0 || tokenIds.length > MAX_BATCH) revert Invalid();
        uint256 removed;
        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i]; Stake memory record = stakeOf[id];
            if (record.account != msg.sender) revert Unauthorized();
            removed += record.weight; delete stakeOf[id];
            uint256 index = _tokenIndex[id];
            uint256 last = _tokens[msg.sender][_tokens[msg.sender].length - 1];
            _tokens[msg.sender][index] = last; _tokenIndex[last] = index;
            _tokens[msg.sender].pop(); delete _tokenIndex[id];
        }
        _checkpoint(_accounts[msg.sender], removed, false);
        _checkpoint(_total, removed, false);
        for (uint256 i; i < tokenIds.length; ++i) {
            nft.safeTransferFrom(address(this), recipient, tokenIds[i]);
            emit Unstaked(msg.sender, tokenIds[i]);
        }
    }
    /// Only stake() may bring a token in through safeTransferFrom; accidental safe deposits revert.
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(nft) || operator != address(this) || stakeOf[tokenId].account != from || from == address(0)) revert Invalid();
        return IERC721Receiver.onERC721Received.selector;
    }
    function stakedTokens(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory result) {
        if (limit > 64) revert Invalid();
        uint256 length = _tokens[account].length;
        if (offset >= length) return new uint256[](0);
        uint256 end = Math.min(length, offset + limit); result = new uint256[](end - offset);
        for (uint256 i; i < result.length; ++i) result[i] = _tokens[account][offset + i];
    }
    function stakedCount(address account) external view returns (uint256) { return _tokens[account].length; }
    function currentWeight(address account) external view returns (uint256) { return _weight(_accounts[account]); }
    function totalCurrentWeight() external view returns (uint256) { return _weight(_total); }
    function _weight(Checkpoint[] storage history) private view returns (uint256) { return history.length == 0 ? 0 : history[history.length - 1].weight; }
    function _checkpoint(Checkpoint[] storage history, uint256 delta, bool add) private {
        uint256 length = history.length;
        uint256 weight = _weight(history);
        uint256 integral = length == 0 ? 0 : history[length - 1].integral + weight * (block.timestamp - history[length - 1].time);
        weight = add ? weight + delta : weight - delta;
        if (length != 0 && history[length - 1].time == block.timestamp) history[length - 1].weight = weight;
        else history.push(Checkpoint(block.timestamp, weight, integral));
    }
    /// Binary search avoids looping through dormant weeks or the NFT population during settlement.
    function _integralAt(Checkpoint[] storage history, uint256 timestamp) private view returns (uint256) {
        uint256 low; uint256 high = history.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (history[mid].time <= timestamp) low = mid + 1; else high = mid;
        }
        if (high == 0) return 0;
        Checkpoint storage point = history[high - 1];
        return point.integral + point.weight * (timestamp - point.time);
    }
    function epochWeight(address account, uint256 epoch) public view returns (uint256) {
        uint256 start = epochStart(epoch); if (start >= block.timestamp) return 0;
        uint256 end = Math.min(start + EPOCH_DURATION, block.timestamp);
        return _integralAt(_accounts[account], end) - _integralAt(_accounts[account], start);
    }
    function totalEpochWeight(uint256 epoch) public view returns (uint256) {
        uint256 start = epochStart(epoch); if (start >= block.timestamp) return 0;
        uint256 end = Math.min(start + EPOCH_DURATION, block.timestamp);
        return _integralAt(_total, end) - _integralAt(_total, start);
    }
    function claimable(address account, uint256 epoch) public view returns (uint256) {
        if (epoch >= currentEpoch() || epochClaimed[account][epoch]) return 0;
        uint256 total = totalEpochWeight(epoch); if (total == 0) return 0;
        return Math.mulDiv(epochRevenue[epoch], epochWeight(account, epoch), total);
    }
    function claimRewards(uint256[] calldata epochs, address payable recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this) || epochs.length == 0 || epochs.length > MAX_BATCH) revert Invalid();
        uint256 amount;
        for (uint256 i; i < epochs.length; ++i) {
            uint256 epoch = epochs[i];
            if (epoch >= currentEpoch()) revert NotReady();
            if (epochClaimed[msg.sender][epoch]) revert Invalid();
            uint256 reward = claimable(msg.sender, epoch);
            epochClaimed[msg.sender][epoch] = true; epochPaid[epoch] += reward; amount += reward;
            emit EpochClaimed(msg.sender, epoch, reward);
        }
        if (amount == 0) revert NothingToClaim();
        nftReserve -= amount; accountedBalance -= amount; totalNftClaimed += amount;
        _send(recipient, amount); emit RewardsClaimed(msg.sender, recipient, amount);
    }
    function claimOwner() external onlyOwner nonReentrant {
        _sync(); uint256 amount = ownerCredit; if (amount == 0) revert NothingToClaim();
        ownerCredit = 0; accountedBalance -= amount; totalOwnerClaimed += amount;
        _send(payable(owner), amount); emit OwnerClaimed(owner, amount);
    }
    /// Empty-cycle income remains NFT money and may fund a later cycle; owner never receives it.
    function rolloverEmptyEpoch(uint256 epoch) external nonReentrant {
        if (epoch >= currentEpoch() || totalEpochWeight(epoch) != 0) revert Invalid();
        uint256 amount = epochRevenue[epoch]; if (amount == 0) revert NothingToClaim();
        epochRevenue[epoch] = 0; uint256 target = currentEpoch(); epochRevenue[target] += amount;
        emit EmptyEpochRolled(epoch, target, amount);
    }
    function pause() external onlyOwner { paused = true; resumeAfter = 0; emit PauseChanged(true, 0); }
    function scheduleResume() external onlyOwner { if (!paused) revert Invalid(); resumeAfter = block.timestamp + DELAY; emit PauseChanged(true, resumeAfter); }
    function resume() external onlyOwner { if (!paused || resumeAfter == 0 || block.timestamp < resumeAfter) revert NotReady(); paused = false; resumeAfter = 0; emit PauseChanged(false, 0); }
    function _send(address payable recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}(""); if (!ok) revert TransferFailed();
    }
}
