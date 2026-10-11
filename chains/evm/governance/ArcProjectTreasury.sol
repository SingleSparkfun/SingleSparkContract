// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IProjectTreasuryFactory {
    function platformToken() external view returns (address);
    function terms(address token) external view returns (uint24 fee, address community, address rewards);
}

/// @notice One project's native-USDC treasury. Project-token stake decides whether its team may claim a quoted DEX budget.
/// @dev No owner, proxy, pause, arbitrary withdrawal or mutable voting parameters. The team can only claim approved proposals.
contract ArcProjectTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant VOTING_DURATION = 7 days;
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant REQUIRED_STAKE = INITIAL_SUPPLY / 100;

    enum Service { TokenInfo, Boost }

    struct Proposal {
        Service service;
        uint256 amount;
        uint64 endsAt;
        uint256 yes;
        uint256 no;
        bytes32 quoteHash;
        bool settled;
        bool approved;
        bool claimed;
    }

    struct Position { uint256 stake; bool support; }

    IProjectTreasuryFactory public immutable factory;
    address public immutable creator;
    address public immutable team;
    IERC20 public token;
    uint256 public quorum;
    uint256 public proposalCount;
    uint256 public activeProposal;
    uint256 public reserved;
    bool public infoApproved;
    bool public infoClaimed; // An approved payout, not proof that DEX Screener delivered the service.
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => Position)) public positions;

    event Bound(address indexed token, uint256 quorum);
    event Proposed(uint256 indexed id, address indexed proposer, Service service, uint256 amount, bytes32 quoteHash, uint64 endsAt);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 amount);
    event Settled(uint256 indexed id, bool approved, uint256 yes, uint256 no);
    event StakeWithdrawn(uint256 indexed id, address indexed voter, uint256 amount);
    event Claimed(uint256 indexed id, address indexed team, uint256 amount);

    error Unauthorized();
    error Invalid();
    error NotReady();
    error TransferFailed();

    constructor(IProjectTreasuryFactory factory_, address creator_, address team_) {
        if (address(factory_).code.length == 0 || creator_ == address(0) || team_ == address(0)) revert Invalid();
        factory = factory_;
        creator = creator_;
        team = team_;
    }

    receive() external payable {}

    /// @notice The factory binds the project token during the launch transaction.
    function bind(address token_) external {
        if (msg.sender != address(factory)) revert Unauthorized();
        if (address(token) != address(0) || token_ == address(0) || token_ == factory.platformToken()) revert Invalid();
        (, address community,) = factory.terms(token_);
        if (community != address(this)) revert Invalid();
        // Burned supply must never lower the 1%-of-initial-supply threshold.
        uint256 supply = IERC20(token_).totalSupply();
        if (supply == 0 || supply > INITIAL_SUPPLY) revert Invalid();
        token = IERC20(token_);
        quorum = REQUIRED_STAKE;
        emit Bound(token_, REQUIRED_STAKE);
    }

    function available() public view returns (uint256) {
        return _balance() - reserved;
    }

    /// @notice Anyone may propose one service and one exact budget; the proposer only pays network Gas.
    /// @dev A quote hash identifies the off-chain checkout evidence for voters. The contract cannot verify DEX prices.
    function propose(Service service, uint256 amount, bytes32 quoteHash) external returns (uint256 id) {
        if (address(token) == address(0) || activeProposal != 0) revert NotReady();
        if (amount == 0 || !_validAmount(amount) || amount > available() || quoteHash == bytes32(0)) revert Invalid();
        if (service == Service.TokenInfo && (infoApproved || infoClaimed)) revert Invalid();
        id = ++proposalCount;
        uint64 endsAt = uint64(block.timestamp + VOTING_DURATION);
        proposals[id] = Proposal(service, amount, endsAt, 0, 0, quoteHash, false, false, false);
        reserved += amount;
        activeProposal = id;
        emit Proposed(id, msg.sender, service, amount, quoteHash, endsAt);
    }

    /// @notice Stake project tokens for exactly one side. More stake may be added to the same side before close.
    function vote(uint256 id, bool support, uint256 amount) external nonReentrant {
        Proposal storage p = proposals[id];
        if (id == 0 || id != activeProposal || block.timestamp >= p.endsAt) revert NotReady();
        if (amount == 0) revert Invalid();
        Position storage position = positions[id][msg.sender];
        if (position.stake != 0 && position.support != support) revert Invalid();
        position.support = support;
        position.stake += amount;
        if (support) p.yes += amount;
        else p.no += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Voted(id, msg.sender, support, amount);
    }

    /// @notice At least 1% of initial supply must participate, and Yes must exceed No.
    function settle(uint256 id) external {
        Proposal storage p = proposals[id];
        if (id == 0 || id != activeProposal || block.timestamp < p.endsAt || p.settled) revert NotReady();
        p.settled = true;
        activeProposal = 0;
        p.approved = p.yes + p.no >= quorum && p.yes > p.no;
        if (p.approved) {
            if (p.service == Service.TokenInfo) infoApproved = true;
        } else reserved -= p.amount;
        emit Settled(id, p.approved, p.yes, p.no);
    }

    function withdrawStake(uint256 id) external nonReentrant {
        Proposal storage p = proposals[id];
        if (id == 0 || block.timestamp < p.endsAt) revert NotReady();
        uint256 amount = positions[id][msg.sender].stake;
        if (amount == 0) revert Invalid();
        delete positions[id][msg.sender];
        token.safeTransfer(msg.sender, amount);
        emit StakeWithdrawn(id, msg.sender, amount);
    }

    /// @notice The fixed platform-team address may claim only an approved proposal's exact amount, once.
    function claim(uint256 id) external nonReentrant {
        if (msg.sender != team) revert Unauthorized();
        Proposal storage p = proposals[id];
        if (id == 0 || !p.settled || !p.approved || p.claimed) revert NotReady();
        p.claimed = true;
        reserved -= p.amount;
        if (p.service == Service.TokenInfo) { infoApproved = false; infoClaimed = true; }
        _pay(team, p.amount);
        emit Claimed(id, team, p.amount);
    }
    function _balance() internal view virtual returns (uint256) { return address(this).balance; }
    function _validAmount(uint256) internal pure virtual returns (bool) { return true; }
    function _pay(address to, uint256 amount) internal virtual {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
