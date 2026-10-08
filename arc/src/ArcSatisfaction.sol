// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISatisfactionFactory {
    function operations() external view returns (address);
    function platformToken() external view returns (address);
    function operationsClaimable() external view returns (uint256);
    function claimOperations() external;
    function fundPlatformBuyback() external payable;
}

/// @notice Receives the factory's 1% platform revenue; SPARK-staked votes decide each round's pot.
/// @dev No owner, pause or upgrade. A decided round always pays its winning side 90% of the pot,
///      pro rata on weight, whichever side that is — so the reward for voting never depends on
///      which way you vote and the result can be read as what people actually think. The team's
///      10% is the only asymmetric part: the team is paid it when the round says people are
///      satisfied, and it becomes a SPARK buyback budget when it says they are not. Void: the pot
///      rolls into the next round. Note the vault therefore funds the buyback only out of that 10%
///      on a Rejected round; the buyback's other source is the trade tax, which is unchanged.
///      Votes are time weighted: `weight = amount * (roundEnd - block.timestamp)`, so staking at the
///      start of the window counts `votingDuration` times the raw stake while a vote one second before
///      the end counts once. That removes the "buy SPARK, vote No, sell" snipe at the closing bell:
///      the late side would need `votingDuration` times the tokens to match an early side. Quorum has
///      two parts: raw stake (its documented meaning) and a weight floor that stops a lone last-second
///      voter from filling quorum unopposed. Winning shares are paid on weight, not raw stake.
contract ArcSatisfaction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SATISFACTION_VERSION = 3;
    uint256 public constant TEAM_BPS = 1_000;

    enum Outcome {
        None,
        Approved,
        Rejected,
        Void
    }

    struct Round {
        uint256 pot;
        uint256 yes; // Time-weighted Yes votes.
        uint256 no; // Time-weighted No votes.
        uint256 yesStake; // Raw SPARK staked for Yes.
        uint256 noStake; // Raw SPARK staked for No.
        bool opened;
        bool settled;
        Outcome outcome;
    }

    struct Position {
        uint256 stake;
        uint256 weight;
        bool support;
        bool withdrawn;
    }

    address public immutable administrator;
    address public immutable team;
    uint256 public immutable genesis;
    uint256 public immutable roundDuration;
    uint256 public immutable votingDuration;
    uint256 public immutable quorum;
    ISatisfactionFactory public factory;
    IERC20 public token;
    uint256 public reserved; // Decided pots, less the team share, not yet pulled by their winning side.
    uint256 public teamCredit;
    uint256 public lastOpened;
    bool public anyOpened;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Position)) public positions;

    event Configured(address indexed factory, address indexed token);
    event VotingOpened(uint256 indexed round, uint256 pot);
    event Voted(
        uint256 indexed round, address indexed voter, bool support, uint256 amount, uint256 weight, bytes32 reasonHash
    );
    event Settled(
        uint256 indexed round, Outcome outcome, uint256 pot, uint256 yes, uint256 no, uint256 yesStake, uint256 noStake
    );
    event Withdrawn(uint256 indexed round, address indexed voter, address to, uint256 stake, uint256 payout);
    event TeamClaimed(uint256 amount);

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidRecipient();
    error NotConfigured();
    error NotVoting();
    error NotDue();
    error SideLocked();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(address team_, uint256 roundDuration_, uint256 votingDuration_, uint256 quorum_) {
        if (
            team_ == address(0) || team_ == address(this) || votingDuration_ == 0 || votingDuration_ >= roundDuration_
                || quorum_ == 0
        ) revert InvalidConfiguration();
        // `configure` is callable only by the deployer, so this vault must be deployed directly by the
        // EOA (or deployer contract) that will later call `configure`. Deploying it through a shared
        // CREATE2 factory would record that factory as `administrator` and leave `configure` uncallable,
        // permanently bricking the vault.
        administrator = msg.sender;
        team = team_;
        genesis = block.timestamp;
        roundDuration = roundDuration_;
        votingDuration = votingDuration_;
        quorum = quorum_;
    }

    receive() external payable {}

    /// @notice One-shot binding; the deployer keeps no authority afterwards.
    function configure(address factory_) external {
        if (msg.sender != administrator || address(factory) != address(0)) revert Unauthorized();
        if (factory_.code.length == 0) revert InvalidConfiguration();
        ISatisfactionFactory value = ISatisfactionFactory(factory_);
        address platform = value.platformToken();
        // `team == factory_` would recycle the team share into the factory's own accounting and
        // `team == platform` would strand it in the token contract; a quorum above the whole supply
        // would make every round Void forever.
        if (
            platform == address(0) || value.operations() != address(this) || team == factory_ || team == platform
                || quorum > IERC20(platform).totalSupply()
        ) revert InvalidConfiguration();
        factory = value;
        token = IERC20(platform);
        emit Configured(factory_, platform);
    }

    function currentRound() public view returns (uint256) {
        return (block.timestamp - genesis) / roundDuration;
    }

    function roundEnd(uint256 round) public view returns (uint256) {
        return genesis + (round + 1) * roundDuration;
    }

    function votingStart(uint256 round) public view returns (uint256) {
        return roundEnd(round) - votingDuration;
    }

    /// @notice Anyone may open the current round once its voting window has started.
    function openVoting() external nonReentrant {
        _open();
    }

    /// @notice Stake SPARK for or against releasing this round's pot. One side per address per round.
    /// @dev The vote counts `amount * (roundEnd - now)`, so earlier stake weighs more and a vote in the
    ///      closing second weighs its raw amount only. Overflow: SPARK supply caps `amount` near 1e27 and
    ///      the multiplier at the voting duration (~2.6e6 for 30 days), so `weight` stays under ~2.6e33
    ///      and `pot * weight` (pot at most ~1e30) under ~2.6e63 — far below 2^256.
    /// @param reasonHash keccak256 of the opinion text stored off-chain; zero when adding stake without a new opinion.
    function vote(bool support, uint256 amount, bytes32 reasonHash) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 round = _open();
        Position storage position = positions[round][msg.sender];
        if (position.stake != 0 && position.support != support) revert SideLocked();
        uint256 weight = amount * (roundEnd(round) - block.timestamp);
        position.support = support;
        position.stake += amount;
        position.weight += weight;
        Round storage data = rounds[round];
        if (support) {
            data.yes += weight;
            data.yesStake += amount;
        } else {
            data.no += weight;
            data.noStake += amount;
        }
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Voted(round, msg.sender, support, amount, weight, reasonHash);
    }

    /// @notice Anyone may settle an opened round once it has ended.
    function settle(uint256 round) external nonReentrant {
        if (!_due(round)) revert NotDue();
        _settle(round);
    }

    /// @notice Returns the caller's stake; a voter on a decided round's winning side also receives their USDC share.
    /// @param to Receives both the SPARK stake and the USDC payout, so a contract voter that cannot take
    ///        native currency can still recover everything by naming an address that can.
    function withdraw(uint256 round, address payable to) external nonReentrant {
        if (to == address(0) || to == address(this) || to == address(token)) revert InvalidRecipient();
        Round storage data = rounds[round];
        if (!data.settled) {
            if (!_due(round)) revert NotDue();
            _settle(round);
        }
        Position storage position = positions[round][msg.sender];
        if (position.stake == 0 || position.withdrawn) revert NothingToWithdraw();
        uint256 payout = payoutOf(round, msg.sender);
        uint256 stake = position.stake;
        position.withdrawn = true;
        reserved -= payout;
        token.safeTransfer(to, stake);
        if (payout != 0) {
            _pay(to, payout);
        }
        emit Withdrawn(round, msg.sender, to, stake, payout);
    }

    /// @notice Pull payment so a team address that cannot receive never blocks settlement.
    function claimTeam() external nonReentrant {
        uint256 amount = teamCredit;
        if (amount == 0) revert InvalidAmount();
        teamCredit = 0;
        _pay(team, amount);
        emit TeamClaimed(amount);
    }

    /// @notice USDC still owed to `voter` for a settled round they were on the winning side of.
    /// @dev The team's 10% is removed first, so the winning side shares 90% of the pot on weight.
    function payoutOf(uint256 round, address voter) public view virtual returns (uint256) {
        Round storage data = rounds[round];
        Position storage position = positions[round][voter];
        if (position.withdrawn) return 0;
        // The winning side shares the pot less the team's 10%, on weight rather than raw stake.
        uint256 sideWeight;
        if (data.outcome == Outcome.Approved && position.support) sideWeight = data.yes;
        else if (data.outcome == Outcome.Rejected && !position.support) sideWeight = data.no;
        else return 0; // the losing side, and every Void or unsettled round
        uint256 distributable = data.pot - _teamShare(data.pot);
        return distributable * position.weight / sideWeight; // Floors; dust below one wei per voter stays reserved.
    }

    function _due(uint256 round) private view returns (bool) {
        Round storage data = rounds[round];
        return data.opened && !data.settled && block.timestamp >= roundEnd(round);
    }

    function _settle(uint256 round) private {
        Round storage data = rounds[round];
        data.settled = true;
        // Two-part quorum: enough raw stake took part, and it did so early enough to be worth half of a
        // quorum staked for the whole window. The floor is what stops one last-second voter from
        // clearing quorum unopposed and walking off with the pot.
        if (
            data.pot == 0 || data.yesStake + data.noStake < quorum || data.yes + data.no < quorum * votingDuration / 2
                || data.yes == data.no
        ) {
            data.outcome = Outcome.Void; // The pot stays unaccounted and joins the next snapshot.
        } else {
            // Both sides are paid the same way, so the reward for voting does not depend on which
            // side you pick. Only the team's 10% differs: the team is paid when the round says
            // people are satisfied, and that same 10% becomes a SPARK buyback when it does not.
            data.outcome = data.yes > data.no ? Outcome.Approved : Outcome.Rejected;
            uint256 teamShare = _teamShare(data.pot);
            // Recorded before any call out, so a factory that re-entered finds the round settled.
            reserved += data.pot - teamShare;
            if (data.outcome == Outcome.Approved) teamCredit += teamShare;
            // A pot under ten wei floors the share to zero, and the factory refuses a zero donation.
            // Settlement must not revert on it: `withdraw` settles a due round on its way, so a
            // reverting settle would lock every voter's stake in that round for good.
            else if (teamShare != 0) _fundBuyback(teamShare);
        }
        emit Settled(round, data.outcome, data.pot, data.yes, data.no, data.yesStake, data.noStake);
    }

    function _open() private returns (uint256 round) {
        if (address(factory) == address(0)) revert NotConfigured();
        round = currentRound();
        if (block.timestamp < votingStart(round)) revert NotVoting();
        Round storage current = rounds[round];
        if (current.opened) return round;
        // A forgotten earlier round is settled first so its pot is never counted twice.
        if (anyOpened && !rounds[lastOpened].settled) _settle(lastOpened);
        // Checked instead of try/catch so a caller cannot starve the claim with a low gas limit.
        if (factory.operationsClaimable() != 0) factory.claimOperations();
        current.opened = true;
        // Money arriving after this snapshot belongs to the next round.
        current.pot = _balance() - reserved - teamCredit;
        lastOpened = round;
        anyOpened = true;
        emit VotingOpened(round, current.pot);
    }
    function _balance() internal view virtual returns (uint256) { return address(this).balance; }
    function _teamShare(uint256 pot) internal pure virtual returns (uint256) { return pot * TEAM_BPS / 10_000; }
    function _fundBuyback(uint256 amount) internal virtual { factory.fundPlatformBuyback{value: amount}(); }
    function _pay(address to, uint256 amount) internal virtual {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
