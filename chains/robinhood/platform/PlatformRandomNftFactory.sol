// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOpenVrf} from "./IOpenVrf.sol";
import {IPlatformNft, IPlatformNftController} from "./IPlatformNft.sol";
import {PlatformRandomNft} from "./PlatformRandomNft.sol";
import {PlatformRandomNftRevenueVault} from "./PlatformRandomNftRevenueVault.sol";

/// Fixed odds, immediately effective recipient-bound eligibility and delayed administrative resumption.
contract PlatformRandomNftFactory is IPlatformNftController, ReentrancyGuard {
    uint256 public constant DELAY = 48 hours;
    uint256 public constant CLAIM_DELAY = 0;
    uint32 public constant CALLBACK_GAS = 150_000;
    uint256 public constant PROBABILITY_SCALE = 10_000;
    address public immutable owner;
    IOpenVrf public immutable randomnessRouter;
    PlatformRandomNft public immutable nft;
    PlatformRandomNftRevenueVault public immutable vault;
    uint16[8] public probabilities;
    bool public paused = true;
    uint256 public resumeAfter;
    uint256 public reservedSupply;
    struct Claim { address recipient; uint256 readyAt; uint256 requestId; bool cancelled; }
    struct Result { bytes32 operation; uint256 word; bool received; bool minted; }
    mapping(bytes32 => Claim) public claims;
    mapping(uint256 => Result) public results;
    error Invalid();
    error Unauthorized();
    error NotReady();
    event ClaimScheduled(bytes32 indexed operation, address indexed recipient, uint256 readyAt);
    event ClaimCancelled(bytes32 indexed operation);
    event ClaimRequested(bytes32 indexed operation, uint256 indexed requestId, address indexed recipient);
    event RandomnessReceived(uint256 indexed requestId, uint256 word, uint8 grade);
    event ClaimMinted(uint256 indexed requestId, address indexed recipient, uint256 indexed tokenId, uint8 grade);
    event GlobalPauseChanged(bool paused, uint256 resumeAfter);

    constructor(address owner_, IOpenVrf router, uint16[8] memory odds, uint16[8] memory weights, string[8] memory artwork) {
        if (block.chainid != 46630 || owner_ == address(0) || address(router).code.length == 0) revert Invalid();
        uint256 sum;
        for (uint256 i; i < 8; ++i) { if (odds[i] == 0) revert Invalid(); sum += odds[i]; }
        if (sum != PROBABILITY_SCALE) revert Invalid();
        owner = owner_; randomnessRouter = router; probabilities = odds;
        nft = new PlatformRandomNft(artwork);
        vault = new PlatformRandomNftRevenueVault(owner_, IPlatformNft(address(nft)), this, weights);
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    receive() external payable { (bool ok,) = address(vault).call{value: msg.value}(""); if (!ok) revert Invalid(); }
    function claimOperation(address recipient, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, recipient, nonce));
    }
    function scheduleClaim(address recipient, bytes32 nonce) external onlyOwner {
        if (recipient == address(0) || recipient == address(vault) || recipient == address(this) || recipient == address(nft) || recipient == address(randomnessRouter)) revert Invalid();
        bytes32 operation = claimOperation(recipient, nonce);
        if (claims[operation].recipient != address(0)) revert Invalid();
        uint256 ready = block.timestamp + CLAIM_DELAY;
        claims[operation] = Claim(recipient, ready, 0, false);
        emit ClaimScheduled(operation, recipient, ready);
    }
    function cancelClaim(bytes32 operation) external onlyOwner {
        Claim storage claim = claims[operation];
        if (claim.recipient == address(0) || claim.cancelled || claim.requestId != 0) revert Invalid();
        claim.cancelled = true; emit ClaimCancelled(operation);
    }
    function requestClaim(bytes32 nonce, uint256 maximumFeeWei) external payable nonReentrant returns (uint256 id) {
        bytes32 operation = claimOperation(msg.sender, nonce);
        Claim storage claim = claims[operation];
        if (paused || claim.recipient != msg.sender || claim.cancelled || claim.readyAt == 0 || block.timestamp < claim.readyAt || claim.requestId != 0) revert NotReady();
        if (nft.mintedSupply() + reservedSupply >= nft.MAX_SUPPLY()) revert Invalid();
        uint256 fee = randomnessRouter.requestFee();
        if (fee > maximumFeeWei || msg.value != fee) revert Invalid();
        ++reservedSupply;
        id = randomnessRouter.requestRandomness{value: fee}(CALLBACK_GAS);
        if (id == 0 || results[id].operation != bytes32(0)) revert Invalid();
        claim.requestId = id; results[id].operation = operation;
        emit ClaimRequested(operation, id, msg.sender);
    }
    function rawFulfillRandomness(uint256 id, uint256 word) external {
        if (msg.sender != address(randomnessRouter)) revert Unauthorized();
        Result storage result = results[id];
        if (result.operation == bytes32(0) || result.received) revert Invalid();
        result.word = word; result.received = true;
        emit RandomnessReceived(id, word, gradeForWord(word));
    }
    function completeClaim(uint256 id) external nonReentrant returns (uint256 tokenId) {
        Result storage result = results[id];
        if (paused || !result.received || result.minted) revert NotReady();
        address recipient = claims[result.operation].recipient;
        uint8 grade = gradeForWord(result.word);
        result.minted = true; --reservedSupply;
        tokenId = nft.mint(recipient, grade);
        emit ClaimMinted(id, recipient, tokenId, grade);
    }
    function gradeForWord(uint256 word) public view returns (uint8) {
        // shortcut: modulo bias is below 1/2^256 per slot; use rejection sampling if exact finite-word uniformity is required.
        uint256 roll = word % PROBABILITY_SCALE;
        uint256 cumulative;
        for (uint8 i; i < 8; ++i) { cumulative += probabilities[i]; if (roll < cumulative) return i + 1; }
        revert Invalid();
    }
    function pause() external onlyOwner { paused = true; resumeAfter = 0; emit GlobalPauseChanged(true, 0); }
    function scheduleResume() external onlyOwner { if (!paused) revert Invalid(); resumeAfter = block.timestamp + DELAY; emit GlobalPauseChanged(true, resumeAfter); }
    function resume() external onlyOwner { if (!paused || resumeAfter == 0 || block.timestamp < resumeAfter) revert NotReady(); paused = false; resumeAfter = 0; emit GlobalPauseChanged(false, 0); }
}
