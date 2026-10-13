// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlatformNft} from "./PlatformNft.sol";
import {PlatformNftRevenueVault} from "./PlatformNftRevenueVault.sol";
import {IPlatformNft, IPlatformNftController} from "./IPlatformNft.sol";

/// One platform collection and its separate income Vault. No Pons project bindings are modified.
contract PlatformNftVaultFactory is IPlatformNftController, ReentrancyGuard {
    uint256 public constant DELAY = 48 hours;
    address public immutable owner;
    PlatformNft public immutable nft;
    PlatformNftRevenueVault public immutable vault;
    bool public paused;
    uint256 public resumeAfter;
    mapping(bytes32 => uint256) public mintReadyAt;
    mapping(bytes32 => bool) public minted;
    error Invalid();
    error Unauthorized();
    error NotReady();
    event PlatformCreated(address indexed owner, address indexed nft, address indexed vault);
    event MintScheduled(bytes32 indexed operation, address indexed recipient, uint8 quality, uint256 readyAt);
    event MintCancelled(bytes32 indexed operation);
    event Minted(bytes32 indexed operation, address indexed recipient, uint256 indexed tokenId);
    event GlobalPauseChanged(bool paused, uint256 resumeAfter);

    constructor(address owner_) {
        if (block.chainid != 46630 || owner_ == address(0)) revert Invalid();
        owner = owner_;
        nft = new PlatformNft(address(this));
        vault = new PlatformNftRevenueVault(owner_, IPlatformNft(address(nft)), IPlatformNftController(address(this)));
        emit PlatformCreated(owner_, address(nft), address(vault));
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    /// May itself be used as a treasury recipient; the native income is forwarded atomically.
    receive() external payable { (bool ok,) = address(vault).call{value: msg.value}(""); if (!ok) revert Invalid(); }
    function mintOperation(address recipient, uint8 quality, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, recipient, quality, nonce));
    }
    function scheduleMint(address recipient, uint8 quality, bytes32 nonce) external onlyOwner {
        if (recipient == address(0) || recipient == address(vault) || quality < 1 || quality > 4) revert Invalid();
        bytes32 operation = mintOperation(recipient, quality, nonce);
        if (mintReadyAt[operation] != 0 || minted[operation]) revert Invalid();
        uint256 ready = block.timestamp + DELAY; mintReadyAt[operation] = ready;
        emit MintScheduled(operation, recipient, quality, ready);
    }
    function cancelMint(bytes32 operation) external onlyOwner {
        if (mintReadyAt[operation] == 0) revert Invalid();
        delete mintReadyAt[operation]; emit MintCancelled(operation);
    }
    function executeMint(address recipient, uint8 quality, bytes32 nonce) external nonReentrant returns (uint256 tokenId) {
        bytes32 operation = mintOperation(recipient, quality, nonce);
        uint256 ready = mintReadyAt[operation];
        if (paused || ready == 0 || block.timestamp < ready) revert NotReady();
        delete mintReadyAt[operation]; minted[operation] = true;
        tokenId = nft.mint(recipient, quality); emit Minted(operation, recipient, tokenId);
    }
    function pause() external onlyOwner { paused = true; resumeAfter = 0; emit GlobalPauseChanged(true, 0); }
    function scheduleResume() external onlyOwner { if (!paused) revert Invalid(); resumeAfter = block.timestamp + DELAY; emit GlobalPauseChanged(true, resumeAfter); }
    function resume() external onlyOwner { if (!paused || resumeAfter == 0 || block.timestamp < resumeAfter) revert NotReady(); paused = false; resumeAfter = 0; emit GlobalPauseChanged(false, 0); }
}
