// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcLaunchV2Fixture} from "./ArcLaunchV2Fixture.sol";
import {ArcSatisfaction} from "../src/ArcSatisfaction.sol";

contract RejectingTeam {
    receive() external payable {
        revert();
    }
}

contract ReentrantTeam {
    ArcSatisfaction vault;

    function arm(ArcSatisfaction vault_) external {
        vault = vault_;
    }

    receive() external payable {
        if (address(vault) != address(0)) vault.claimTeam();
    }
}

contract ReentrantVoter {
    ArcSatisfaction vault;
    uint256 round;

    constructor(ArcSatisfaction vault_) {
        vault = vault_;
    }

    function vote(IERC20 token, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.vote(false, amount, bytes32(0));
    }

    function withdraw(uint256 round_, address payable to) external {
        round = round_;
        vault.withdraw(round_, to);
    }

    receive() external payable {
        vault.withdraw(round, payable(address(this)));
    }
}

/// @notice Stands in for the factory so `configure`'s degenerate-binding checks can be reached one by one.
contract MockFactory {
    address public operations;
    address public platformToken;

    function set(address operations_, address platformToken_) external {
        operations = operations_;
        platformToken = platformToken_;
    }
}

contract ArcSatisfactionTest is ArcLaunchV2Fixture {
    uint256 constant GENESIS = 1000;
    uint256 constant ROUND = 30 days;
    uint256 constant VOTING = 7 days;
    uint256 constant QUORUM = 1_000e18;
    ArcSatisfaction vault;
    address team = address(0x7ea4);
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address carol = address(0xca401);

    function setUp() public {
        _install(team);
    }

    /// The vault must exist before the factory because `operations` is immutable in the factory.
    function _install(address team_) internal {
        vm.warp(GENESIS);
        vault = new ArcSatisfaction(team_, ROUND, VOTING, QUORUM);
        _deploy(address(vault));
        vault.configure(address(launch));
        // Fill the factory's retained 1 USDC gas buffer so every later 1% credit is fully claimable.
        launch.fundKeeperGas{value: 1e18}();
        _voter(alice, 10_000e18);
        _voter(bob, 10_000e18);
        _voter(carol, 10_000e18);
    }

    function _voter(address who, uint256 amount) internal {
        deal(jet, who, amount);
        vm.prank(who);
        IERC20(jet).approve(address(vault), type(uint256).max);
    }

    /// fundFees splits 83/7/5/4/1, so 100x the pot credits exactly `pot` to the platform treasury.
    function _fundPot(uint256 pot) internal {
        launch.fundFees{value: pot * 100}(project);
    }

    function _toVoting(uint256 round) internal {
        vm.warp(GENESIS + (round + 1) * ROUND - VOTING);
    }

    function _toEnd(uint256 round) internal {
        vm.warp(GENESIS + (round + 1) * ROUND);
    }

    /// The two invariants that must hold after every step: solvency and stake custody.
    function _assertSolvent(uint256 heldStake) internal view {
        assertGe(address(vault).balance, vault.reserved() + vault.teamCredit());
        assertEq(IERC20(jet).balanceOf(address(vault)), heldStake);
    }

    function testParametersAndRoundSchedule() public view {
        assertEq(vault.SATISFACTION_VERSION(), 3);
        assertEq(vault.TEAM_BPS(), 1_000);
        assertEq(vault.team(), team);
        assertEq(vault.genesis(), GENESIS);
        assertEq(vault.roundDuration(), ROUND);
        assertEq(vault.votingDuration(), VOTING);
        assertEq(vault.quorum(), QUORUM);
        assertEq(address(vault.factory()), address(launch));
        assertEq(address(vault.token()), jet);
        assertEq(launch.operations(), address(vault));
        assertEq(vault.currentRound(), 0);
        assertEq(vault.roundEnd(0), GENESIS + ROUND);
        assertEq(vault.votingStart(0), GENESIS + ROUND - VOTING);
        assertEq(vault.roundEnd(2), GENESIS + 3 * ROUND);
    }

    function testConstructorRejectsInvalidParameters() public {
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        new ArcSatisfaction(address(0), ROUND, VOTING, QUORUM);
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        new ArcSatisfaction(team, ROUND, 0, QUORUM);
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        new ArcSatisfaction(team, ROUND, ROUND, QUORUM);
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        new ArcSatisfaction(team, ROUND, VOTING, 0);
    }

    function testConfigureIsOneShotAdminOnlyAndValidatesTheFactory() public {
        ArcSatisfaction other = new ArcSatisfaction(team, ROUND, VOTING, QUORUM);
        vm.prank(alice);
        vm.expectRevert(ArcSatisfaction.Unauthorized.selector);
        other.configure(address(launch));
        // This factory pays `vault`, not `other`.
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        other.configure(address(launch));
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        other.configure(alice);
        vm.expectRevert(ArcSatisfaction.Unauthorized.selector);
        vault.configure(address(launch));
    }

    function testConfigureRejectsDegenerateBindings() public {
        MockFactory mock = new MockFactory();
        uint256 supply = IERC20(jet).totalSupply();

        // The team address must not be the factory itself, which would recycle the share into its books.
        ArcSatisfaction teamIsFactory = new ArcSatisfaction(address(mock), ROUND, VOTING, QUORUM);
        mock.set(address(teamIsFactory), jet);
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        teamIsFactory.configure(address(mock));

        // Nor the platform token, which cannot forward native currency.
        ArcSatisfaction teamIsToken = new ArcSatisfaction(jet, ROUND, VOTING, QUORUM);
        mock.set(address(teamIsToken), jet);
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        teamIsToken.configure(address(mock));

        // A quorum above the whole supply could never be met, making every round Void forever.
        ArcSatisfaction tooMuch = new ArcSatisfaction(team, ROUND, VOTING, supply + 1);
        mock.set(address(tooMuch), jet);
        vm.expectRevert(ArcSatisfaction.InvalidConfiguration.selector);
        tooMuch.configure(address(mock));

        // Exactly the supply is still a legal (if extreme) choice.
        ArcSatisfaction atSupply = new ArcSatisfaction(team, ROUND, VOTING, supply);
        mock.set(address(atSupply), jet);
        atSupply.configure(address(mock));
        assertEq(address(atSupply.factory()), address(mock));
        assertEq(address(atSupply.token()), jet);
    }

    function testVotingOnlyInsideTheWindowAndSnapshotsThePot() public {
        _fundPot(10e18);
        vm.warp(GENESIS + 1 days);
        vm.expectRevert(ArcSatisfaction.NotVoting.selector);
        vault.openVoting();
        vm.prank(alice);
        vm.expectRevert(ArcSatisfaction.NotVoting.selector);
        vault.vote(true, 1e18, bytes32(0));

        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 3_000e18, keccak256("great work"));
        (uint256 pot, uint256 yes, uint256 no, uint256 yesStake, uint256 noStake, bool opened, bool settled,) =
            vault.rounds(0);
        assertEq(pot, 10e18);
        assertEq(yes, 3_000e18 * VOTING); // a vote at the opening second carries the full multiplier
        assertEq(no, 0);
        assertEq(yesStake, 3_000e18);
        assertEq(noStake, 0);
        assertTrue(opened);
        assertFalse(settled);
        assertEq(address(vault).balance, 10e18);
        assertEq(launch.operationsClaimable(), 0);
        assertEq(IERC20(jet).balanceOf(address(vault)), 3_000e18);
        assertEq(IERC20(jet).balanceOf(alice), 7_000e18);
    }

    function testVoterCanAddToTheSameSideButNotSwitch() public {
        _toVoting(0);
        vm.startPrank(alice);
        vault.vote(false, 100e18, keccak256("first"));
        vault.vote(false, 50e18, bytes32(0));
        vm.expectRevert(ArcSatisfaction.SideLocked.selector);
        vault.vote(true, 1e18, bytes32(0));
        vm.expectRevert(ArcSatisfaction.InvalidAmount.selector);
        vault.vote(false, 0, bytes32(0));
        vm.stopPrank();
        (uint256 stake, uint256 weight, bool support, bool withdrawn) = vault.positions(0, alice);
        assertEq(stake, 150e18);
        assertEq(weight, 150e18 * VOTING); // both top-ups landed at the same second
        assertFalse(support);
        assertFalse(withdrawn);
        (,, uint256 no,, uint256 noStake,,,) = vault.rounds(0);
        assertEq(no, 150e18 * VOTING);
        assertEq(noStake, 150e18);
    }

    function testOpeningWithNothingClaimableGivesAZeroPot() public {
        _toVoting(0);
        vault.openVoting();
        (uint256 pot,,,,, bool opened,,) = vault.rounds(0);
        assertEq(pot, 0);
        assertTrue(opened);
        vault.openVoting(); // idempotent
    }

    function testUnconfiguredVaultRejectsVotes() public {
        ArcSatisfaction other = new ArcSatisfaction(team, ROUND, VOTING, QUORUM);
        vm.warp(block.timestamp + ROUND - VOTING);
        vm.expectRevert(ArcSatisfaction.NotConfigured.selector);
        other.openVoting();
    }

    function testApprovedPaysTeamTenPercentAndTheSatisfiedVoters() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 3_000e18, keccak256("great work"));
        vm.prank(bob);
        vault.vote(false, 1_000e18, keccak256("too slow"));
        (, uint256 budgetBefore,,,,,) = launch.tokens(jet);

        vm.expectRevert(ArcSatisfaction.NotDue.selector);
        vault.settle(0);
        _toEnd(0);
        vault.settle(0);
        vm.expectRevert(ArcSatisfaction.NotDue.selector);
        vault.settle(0);

        (,,,,,, bool settled, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertTrue(settled);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Approved));
        assertEq(vault.teamCredit(), 1e18);
        assertEq(vault.reserved(), 9e18); // the winning side's 90%, waiting to be pulled
        (, uint256 budgetAfter,,,,,) = launch.tokens(jet);
        assertEq(budgetAfter - budgetBefore, 0); // an Approved round no longer funds the buyback
        assertEq(vault.payoutOf(0, alice), 9e18); // the only Satisfied voter takes all of it
        assertEq(vault.payoutOf(0, bob), 0); // the losing side is owed nothing
        assertEq(address(vault).balance, 10e18);
        assertEq(address(launch).balance, launch.nativeAccounted());

        vault.claimTeam();
        assertEq(team.balance, 1e18);
        assertEq(vault.teamCredit(), 0);
        vm.expectRevert(ArcSatisfaction.InvalidAmount.selector);
        vault.claimTeam();

        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
        assertEq(alice.balance, 9e18); // the Satisfied side is paid exactly as the other side would be
        assertEq(bob.balance, 0);
        assertEq(IERC20(jet).balanceOf(address(vault)), 0);
        assertEq(address(vault).balance, 0);
    }

    function testRejectedSplitsThePotAmongNoVotersProRata() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 3_000e18, keccak256("no roadmap"));
        vm.prank(bob);
        vault.vote(false, 1_000e18, keccak256("no updates"));
        vm.prank(carol);
        vault.vote(true, 500e18, keccak256("fine by me"));

        vm.prank(alice);
        vm.expectRevert(ArcSatisfaction.NotDue.selector);
        vault.withdraw(0, payable(alice));

        _toEnd(0);
        assertEq(vault.payoutOf(0, alice), 0); // not settled yet
        vm.prank(alice);
        vault.withdraw(0, payable(alice)); // settles the due round on the way
        (,,,,,, bool settled, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertTrue(settled);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Rejected));
        assertEq(alice.balance, 6.75e18);
        assertEq(vault.payoutOf(0, bob), 2.25e18);
        assertEq(vault.payoutOf(0, carol), 0);
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        vm.prank(carol);
        vault.withdraw(0, payable(carol));
        assertEq(bob.balance, 2.25e18);
        assertEq(carol.balance, 0);
        assertEq(IERC20(jet).balanceOf(carol), 10_000e18);
        assertEq(vault.teamCredit(), 0);
        assertEq(vault.reserved(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(team.balance, 0);

        vm.prank(alice);
        vm.expectRevert(ArcSatisfaction.NothingToWithdraw.selector);
        vault.withdraw(0, payable(alice));
        vm.prank(team);
        vm.expectRevert(ArcSatisfaction.NothingToWithdraw.selector);
        vault.withdraw(0, payable(team));
    }

    function testBelowQuorumIsVoidAndThePotRollsIntoTheNextRound() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 400e18, bytes32(0));
        vm.prank(bob);
        vault.vote(false, 500e18, bytes32(0)); // 900 < 1,000 quorum
        _fundPot(5e18);
        _toVoting(1);
        vm.prank(carol);
        vault.vote(false, 2_000e18, bytes32(0)); // opening round 1 settles round 0 first
        (,,,,,, bool settled, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertTrue(settled);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));
        (uint256 pot,,,,,,,) = vault.rounds(1);
        assertEq(pot, 15e18);
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(bob.balance, 0);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
    }

    /// Exactly `quorum` raw stake, cast early enough to clear the weight floor, is enough to decide a round.
    function testQuorumBoundaryExactlyMetApproves() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 600e18, bytes32(0));
        vm.prank(bob);
        vault.vote(false, 400e18, bytes32(0));
        (,,, uint256 yesStake, uint256 noStake,,,) = vault.rounds(0);
        assertEq(yesStake + noStake, QUORUM);
        _toEnd(0);
        vault.settle(0);
        (,, uint256 no,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Approved));
        assertEq(no, 400e18 * VOTING);
        assertEq(vault.teamCredit(), 1e18);
    }

    function testQuorumBoundaryOneWeiShortIsVoid() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 600e18, bytes32(0));
        vm.prank(bob);
        vault.vote(false, 400e18 - 1, bytes32(0));
        (,,, uint256 yesStake, uint256 noStake,,,) = vault.rounds(0);
        assertEq(yesStake + noStake, QUORUM - 1);
        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));
        assertEq(vault.teamCredit(), 0);
        assertEq(vault.reserved(), 0);
        assertEq(address(vault).balance, 10e18);
    }

    /// A one-wei pot rounds the team share to zero; the buyback call must still go through.
    function testApprovedOneWeiPotPaysTheWholeWeiToTheWinner() public {
        _fundPot(1);
        _toVoting(0);
        (, uint256 budgetBefore,,,,,) = launch.tokens(jet);
        vm.prank(alice);
        vault.vote(true, 1_000e18, bytes32(0));
        (uint256 pot,,,,,,,) = vault.rounds(0);
        assertEq(pot, 1);
        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Approved));
        assertEq(vault.teamCredit(), 0); // one wei floors the team share to nothing
        (, uint256 budgetAfter,,,,,) = launch.tokens(jet);
        assertEq(budgetAfter - budgetBefore, 0);
        assertEq(vault.reserved(), 1);
        assertEq(vault.payoutOf(0, alice), 1);
        assertEq(address(vault).balance, 1);
    }

    function testTieIsVoid() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 1_000e18, bytes32(0));
        vm.prank(bob);
        vault.vote(false, 1_000e18, bytes32(0));
        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));
        assertEq(vault.reserved(), 0); // nobody won, so nobody is owed a share
        assertEq(vault.teamCredit(), 0); // and the team is not paid either
        assertEq(address(vault).balance, 10e18);

        // Both stakes still come back in full.
        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);

        // And the whole tied pot becomes the next round's pot, untouched.
        _toVoting(1);
        vault.openVoting();
        (uint256 next,,,,,,,) = vault.rounds(1);
        assertEq(next, 10e18);
        assertEq(address(vault).balance, 10e18);
    }

    function testMoneyArrivingDuringVotingBelongsToTheNextRound() public {
        _fundPot(10e18);
        _toVoting(0);
        vault.openVoting();
        _fundPot(4e18); // stays claimable in the factory
        (bool sent,) = address(vault).call{value: 1e18}(""); // direct donation
        assertTrue(sent);
        vm.prank(bob);
        vault.vote(false, 1_000e18, bytes32(0));
        (uint256 pot,,,,,,,) = vault.rounds(0);
        assertEq(pot, 10e18);
        _toEnd(0);
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(bob.balance, 9e18); // the pot less the team's 10%, which left for the buyback budget

        _toVoting(1);
        vault.openVoting();
        (uint256 next,,,,,,,) = vault.rounds(1);
        assertEq(next, 5e18);
    }

    /// `claimOperations` is permissionless; a stranger pulling it mid-round must not resize the open pot.
    function testThirdPartyClaimOperationsMidRoundGoesToNextPot() public {
        _fundPot(10e18);
        _toVoting(0);
        vault.openVoting();
        (uint256 pot,,,,,,,) = vault.rounds(0);
        assertEq(pot, 10e18);

        _fundPot(4e18);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        launch.claimOperations();
        assertEq(address(vault).balance, 14e18);

        (uint256 unchangedPot,,,,,,,) = vault.rounds(0);
        assertEq(unchangedPot, 10e18);

        _toVoting(1);
        vault.openVoting(); // settles round 0 as Void, then snapshots everything for round 1
        (uint256 next,,,,,,,) = vault.rounds(1);
        assertEq(next, 14e18);
    }

    function testSkippedRoundsNeedNoUpkeep() public {
        _fundPot(10e18);
        _toVoting(3); // rounds 0-2 were never opened
        vm.prank(alice);
        vault.vote(true, 1_000e18, bytes32(0));
        assertEq(vault.currentRound(), 3);
        (uint256 pot,,,,,,,) = vault.rounds(3);
        assertEq(pot, 10e18);
        vm.expectRevert(ArcSatisfaction.NotDue.selector);
        vault.settle(1); // never opened, so never settleable
    }

    function testZeroPotRoundIsVoidAndStakesReturn() public {
        _toVoting(0);
        vm.prank(bob);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));
        assertEq(bob.balance, 0);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
    }

    function testTeamThatCannotReceiveDoesNotBlockSettlement() public {
        _install(address(new RejectingTeam()));
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 1_000e18, bytes32(0));
        _toEnd(0);
        vault.settle(0);
        assertEq(vault.teamCredit(), 1e18);
        vm.expectRevert(ArcSatisfaction.TransferFailed.selector);
        vault.claimTeam();
        assertEq(vault.teamCredit(), 1e18);
        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
    }

    function testClaimTeamCannotBeReentered() public {
        ReentrantTeam reentrant = new ReentrantTeam();
        _install(address(reentrant));
        reentrant.arm(vault);
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 3_000e18, bytes32(0));
        _toEnd(0);
        vault.settle(0);
        assertEq(vault.teamCredit(), 1e18);
        vm.expectRevert(ArcSatisfaction.TransferFailed.selector);
        vault.claimTeam();
        assertEq(vault.teamCredit(), 1e18); // the failed transfer rolled the zeroing back
        assertEq(address(reentrant).balance, 0);
        assertEq(address(vault).balance, 10e18); // 1 team credit plus the 9 reserved for the winning side
    }

    function testReentrantWithdrawCannotDoubleCollect() public {
        ReentrantVoter attacker = new ReentrantVoter(vault);
        deal(jet, address(attacker), 2_000e18);
        _fundPot(10e18);
        _toVoting(0);
        attacker.vote(IERC20(jet), 2_000e18);
        vm.prank(bob);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);
        vm.expectRevert(ArcSatisfaction.TransferFailed.selector);
        attacker.withdraw(0, payable(address(attacker)));
        (,,, bool withdrawn) = vault.positions(0, address(attacker));
        assertFalse(withdrawn);
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(bob.balance, 4.5e18);
        assertEq(vault.reserved(), 4.5e18); // the attacker's share stays reserved, not redistributed

        // The recipient argument is the escape hatch: paying a plain address avoids the hostile receive().
        address rescue = makeAddr("rescue");
        attacker.withdraw(0, payable(rescue));
        assertEq(rescue.balance, 4.5e18);
        assertEq(IERC20(jet).balanceOf(rescue), 2_000e18);
        assertEq(vault.reserved(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(IERC20(jet).balanceOf(address(vault)), 0);
    }

    function testWithdrawRejectsTheZeroRecipient() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);
        vm.prank(alice);
        vm.expectRevert(ArcSatisfaction.InvalidRecipient.selector);
        vault.withdraw(0, payable(address(0)));
    }

    /// Sending the recipient as the vault or the SPARK token itself would strand the stake forever,
    /// since nothing can sweep tokens back out of either address.
    function testWithdrawRejectsSelfAndTokenRecipients() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);

        vm.startPrank(alice);
        vm.expectRevert(ArcSatisfaction.InvalidRecipient.selector);
        vault.withdraw(0, payable(address(vault)));
        vm.expectRevert(ArcSatisfaction.InvalidRecipient.selector);
        vault.withdraw(0, payable(jet));
        vault.withdraw(0, payable(alice));
        vm.stopPrank();

        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
        assertEq(alice.balance, 9e18);
    }

    /// A vote one second before the end carries a multiplier of 1, so it cannot outweigh an early side.
    function testLastSecondSniperCannotTakeThePot() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 3_000e18, keccak256("shipped on time"));

        address sniper = makeAddr("sniper");
        _voter(sniper, 100_000e18);
        vm.warp(vault.roundEnd(0) - 1);
        vm.prank(sniper);
        vault.vote(false, 100_000e18, keccak256("pay me"));

        (, uint256 yes, uint256 no,,,,,) = vault.rounds(0);
        assertEq(yes, 3_000e18 * VOTING);
        assertEq(no, 100_000e18); // 33x the raw stake still buys only 1/18,144th of the weight

        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Approved));
        assertEq(vault.payoutOf(0, sniper), 0);

        vm.prank(sniper);
        vault.withdraw(0, payable(sniper));
        assertEq(sniper.balance, 0);
        assertEq(IERC20(jet).balanceOf(sniper), 100_000e18);
    }

    /// Raw quorum alone is not enough: unopposed last-second stake fails the weight floor and voids the round.
    function testLoneLastSecondVoterIsVoid() public {
        _fundPot(10e18);
        vm.warp(vault.roundEnd(0) - 1);
        vm.prank(bob);
        vault.vote(false, 2_000e18, bytes32(0)); // twice the raw quorum
        (uint256 pot,, uint256 no,, uint256 noStake,,,) = vault.rounds(0);
        assertEq(pot, 10e18);
        assertEq(no, 2_000e18);
        assertGe(noStake, QUORUM);
        assertLt(no, QUORUM * VOTING / 2); // below the floor

        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));
        assertEq(vault.reserved(), 0);

        _toVoting(1);
        vault.openVoting();
        (uint256 next,,,,,,,) = vault.rounds(1);
        assertEq(next, 10e18); // the pot rolls over untouched

        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(bob.balance, 0);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
    }

    /// Equal stakes, different moments: the payout ratio is exactly the ratio of the remaining seconds.
    function testEarlierVotesWeighMore() public {
        _fundPot(9e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 3_000e18, bytes32(0)); // VOTING seconds left
        vm.warp(vault.roundEnd(0) - VOTING / 2);
        vm.prank(bob);
        vault.vote(false, 3_000e18, bytes32(0)); // VOTING/2 seconds left

        (uint256 aliceStake, uint256 aliceWeight,,) = vault.positions(0, alice);
        (uint256 bobStake, uint256 bobWeight,,) = vault.positions(0, bob);
        assertEq(aliceStake, bobStake);
        assertEq(aliceWeight, 3_000e18 * VOTING);
        assertEq(bobWeight, 3_000e18 * (VOTING / 2));
        assertEq(aliceWeight, 2 * bobWeight);

        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Rejected));
        // 8.1 USDC — the 9 less the team's 10% — split 2:1 by weight although the stakes are identical.
        assertEq(vault.payoutOf(0, alice), 5.4e18);
        assertEq(vault.payoutOf(0, bob), 2.7e18);
        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(alice.balance, 5.4e18);
        assertEq(bob.balance, 2.7e18);
        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
        assertEq(vault.reserved(), 0);
        assertEq(address(vault).balance, 0);
    }

    function testVotingWindowBoundaries() public {
        _fundPot(10e18);
        vm.warp(vault.votingStart(0) - 1);
        vm.prank(alice);
        vm.expectRevert(ArcSatisfaction.NotVoting.selector);
        vault.vote(true, 1_000e18, bytes32(0));

        vm.warp(vault.votingStart(0));
        vm.prank(alice);
        vault.vote(true, 1_000e18, bytes32(0));
        (, uint256 yes,,,,,,) = vault.rounds(0);
        assertEq(yes, 1_000e18 * VOTING);

        // At roundEnd(0) the clock already belongs to round 1, whose own window has not started.
        vm.warp(vault.roundEnd(0));
        assertEq(vault.currentRound(), 1);
        assertLt(vault.roundEnd(0), vault.votingStart(1));
        vm.prank(bob);
        vm.expectRevert(ArcSatisfaction.NotVoting.selector);
        vault.vote(false, 1_000e18, bytes32(0));

        // The finished round is settleable at that very second.
        vault.settle(0);
        (,,,,,, bool settled, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertTrue(settled);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Approved));
    }

    function testWithdrawByNonVoterRollsBackLazySettlement() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);
        vm.prank(carol);
        vm.expectRevert(ArcSatisfaction.NothingToWithdraw.selector);
        vault.withdraw(0, payable(carol));
        (,,,,,, bool settled, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertFalse(settled); // the revert undid the lazy settlement too
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.None));
        assertEq(vault.reserved(), 0);
        vault.settle(0);
        (,,,,,, bool later,) = vault.rounds(0);
        assertTrue(later);
    }

    /// Rounds 0 (Rejected, unclaimed), 1 (Approved, settled lazily) and 3 (Void); round 2 never opens.
    function testMultiRoundConservation() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(bob);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome first) = vault.rounds(0);
        assertEq(uint8(first), uint8(ArcSatisfaction.Outcome.Rejected));
        assertEq(vault.reserved(), 9e18); // the pot less the team's 10%
        _assertSolvent(2_000e18);

        // Round 1 is opened by a Yes vote and deliberately left unsettled.
        _fundPot(20e18);
        _toVoting(1);
        vm.prank(alice);
        vault.vote(true, 3_000e18, bytes32(0));
        (uint256 potOne,,,,,,,) = vault.rounds(1);
        assertEq(potOne, 20e18); // the reserved round-0 pot is excluded
        _assertSolvent(5_000e18);

        // Round 2 is skipped entirely; opening round 3 settles round 1 on the way.
        _fundPot(5e18);
        _toVoting(3);
        vm.prank(carol);
        vault.vote(false, 500e18, bytes32(0)); // below quorum on purpose
        (,,,,,, bool settledOne, ArcSatisfaction.Outcome second) = vault.rounds(1);
        assertTrue(settledOne);
        assertEq(uint8(second), uint8(ArcSatisfaction.Outcome.Approved));
        assertEq(vault.teamCredit(), 2e18);
        assertEq(vault.reserved(), 9e18 + 18e18); // round 0's No share and round 1's Yes share
        (uint256 potThree,,,,,,,) = vault.rounds(3);
        assertEq(potThree, 5e18);
        _assertSolvent(5_500e18);

        _toEnd(3);
        vault.settle(3);
        (,,,,,,, ArcSatisfaction.Outcome third) = vault.rounds(3);
        assertEq(uint8(third), uint8(ArcSatisfaction.Outcome.Void));
        assertEq(vault.reserved(), 27e18);
        assertEq(vault.teamCredit(), 2e18);
        assertEq(address(vault).balance, 34e18); // 27 reserved + 2 team + 5 rolling
        _assertSolvent(5_500e18);

        // The round-0 No voter shows up three rounds late and is still owed the exact original share.
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(bob.balance, 9e18);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
        assertEq(vault.reserved(), 18e18); // round 1's Yes share is still unclaimed
        assertEq(address(vault).balance, 25e18);
        _assertSolvent(3_500e18);

        // And the round-1 Yes voter is owed exactly the same 90%, proving the sides are symmetric.
        assertEq(vault.payoutOf(1, alice), 18e18);
        vm.prank(alice);
        vault.withdraw(1, payable(alice));
        assertEq(alice.balance, 18e18);
        assertEq(vault.reserved(), 0);
        assertEq(address(vault).balance, 7e18); // the 2 team credit and the 5 rolling into round 4
    }

    function testEventsCarryTheWeightedNumbers() public {
        _fundPot(10e18);
        _toVoting(0);
        uint256 weight = 2_000e18 * VOTING;

        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.VotingOpened(0, 10e18);
        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.Voted(0, alice, false, 2_000e18, weight, keccak256("nope"));
        vm.prank(alice);
        vault.vote(false, 2_000e18, keccak256("nope"));

        _toEnd(0);
        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.Settled(0, ArcSatisfaction.Outcome.Rejected, 10e18, 0, weight, 0, 2_000e18);
        vault.settle(0);

        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.Withdrawn(0, alice, bob, 2_000e18, 9e18);
        vm.prank(alice);
        vault.withdraw(0, payable(bob)); // both legs go to the named recipient
        assertEq(bob.balance, 9e18); // the Settled event still names the whole pot; 10% went to the buyback
        assertEq(IERC20(jet).balanceOf(bob), 12_000e18);
    }

    function testLazySettlementAndTeamClaimEmit() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 3_000e18, bytes32(0));
        uint256 weight = 3_000e18 * VOTING;

        _fundPot(5e18);
        _toVoting(1);
        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.Settled(0, ArcSatisfaction.Outcome.Approved, 10e18, weight, 0, 3_000e18, 0);
        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.VotingOpened(1, 5e18);
        vault.openVoting();

        vm.expectEmit(true, true, false, true);
        emit ArcSatisfaction.TeamClaimed(1e18);
        vault.claimTeam();
        assertEq(team.balance, 1e18);
    }

    /// Exactly at the window midpoint the weight floor is met, not missed: the round decides. One second
    /// later, in a fresh round, the same stake falls just short of the floor and the round is Void.
    function testWeightFloorBoundary() public {
        _fundPot(10e18);
        vm.warp(vault.roundEnd(0) - VOTING / 2);
        vm.prank(alice);
        vault.vote(true, QUORUM, bytes32(0));
        (, uint256 yes, uint256 no,,,,,) = vault.rounds(0);
        assertEq(yes + no, QUORUM * VOTING / 2);
        _toEnd(0);
        vault.settle(0);
        (uint256 pot0,,,,,, bool settled0, ArcSatisfaction.Outcome outcome0) = vault.rounds(0);
        assertTrue(settled0);
        assertEq(uint8(outcome0), uint8(ArcSatisfaction.Outcome.Approved));
        assertGt(pot0, 0);

        _fundPot(10e18);
        vm.warp(vault.roundEnd(1) - VOTING / 2 + 1);
        vm.prank(bob);
        vault.vote(true, QUORUM, bytes32(0));
        (, uint256 yes1, uint256 no1,,,,,) = vault.rounds(1);
        assertEq(yes1 + no1, QUORUM * (VOTING / 2 - 1));
        assertLt(yes1 + no1, QUORUM * VOTING / 2); // one second later, the same stake now misses the floor
        _toEnd(1);
        vault.settle(1);
        (,,,,,,, ArcSatisfaction.Outcome outcome1) = vault.rounds(1);
        assertEq(uint8(outcome1), uint8(ArcSatisfaction.Outcome.Void));
    }

    /// A top-up at a later second is weighted on its own remaining time, not blended with the earlier stake.
    function testTopUpAtALaterSecondIsWeightedSeparately() public {
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 100e18, bytes32(0));
        vm.warp(vault.votingStart(0) + VOTING / 2);
        vm.prank(alice);
        vault.vote(false, 50e18, bytes32(0));

        (uint256 stake, uint256 weight, bool support, bool withdrawn) = vault.positions(0, alice);
        uint256 expectedWeight = 100e18 * VOTING + 50e18 * (VOTING / 2);
        assertEq(weight, expectedWeight);
        assertTrue(weight != 150e18 * (VOTING / 2));
        assertTrue(weight != 150e18 * VOTING);
        assertEq(stake, 150e18);
        assertFalse(support);
        assertFalse(withdrawn);

        (,, uint256 no,, uint256 noStake,,,) = vault.rounds(0);
        assertEq(no, expectedWeight);
        assertEq(noStake, 150e18);
    }

    /// Weight, not raw stake, decides the outcome: an early minority stake can match a later majority stake.
    function testEqualWeightsWithUnequalStakesTie() public {
        _fundPot(10e18);
        _toVoting(0);
        vm.prank(alice);
        vault.vote(true, 1_000e18, bytes32(0));
        vm.warp(vault.votingStart(0) + VOTING / 2);
        vm.prank(bob);
        vault.vote(false, 2_000e18, bytes32(0));

        (, uint256 yes, uint256 no, uint256 yesStake, uint256 noStake,,,) = vault.rounds(0);
        assertEq(yes, no);
        assertTrue(yesStake != noStake);

        _toEnd(0);
        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));
    }

    /// Raw stake alone clears quorum, but casting it all in the closing second still misses the weight
    /// floor, so the round is Void even though both sides showed up.
    function testRawQuorumMetButWeightFloorMissedIsVoidEvenWithOpposition() public {
        _fundPot(10e18);
        vm.warp(vault.roundEnd(0) - 1);
        vm.prank(alice);
        vault.vote(true, 1e18, bytes32(0));
        vm.prank(bob);
        vault.vote(false, 1_000e18, bytes32(0));

        (, uint256 yes, uint256 no, uint256 yesStake, uint256 noStake,,,) = vault.rounds(0);
        assertGe(yesStake + noStake, QUORUM);
        assertLt(yes + no, QUORUM * VOTING / 2);

        _toEnd(0);
        vault.settle(0);
        (uint256 pot,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Void));

        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
        assertEq(IERC20(jet).balanceOf(bob), 10_000e18);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);

        _toVoting(1);
        vault.openVoting();
        (uint256 next,,,,,,,) = vault.rounds(1);
        assertEq(next, pot);
    }

    /// Mixed Yes/No sides at fuzzed stakes and moments: stakes always return in full, and native currency
    /// only ever moves to a voter who was on the winning side of a decided round.
    function testFuzzMixedSidesConserveFunds(
        uint256 potSeed,
        uint256[4] memory stakeSeeds,
        bool[4] memory sideSeeds,
        uint256[4] memory timeSeeds
    ) public {
        uint256 pot = bound(potSeed, 1, 500e18);
        _fundPot(pot);
        _toVoting(0);
        address[4] memory voters = [makeAddr("m0"), makeAddr("m1"), makeAddr("m2"), makeAddr("m3")];
        uint256[4] memory stakes;
        bool[4] memory sides;
        uint256 at = vault.votingStart(0);
        for (uint256 i; i < 4; i++) {
            // Voter 0 stakes at least the quorum, No, at the opening second, so both quorum parts hold.
            stakes[i] = bound(stakeSeeds[i], i == 0 ? QUORUM : 1, 1_000_000e18);
            sides[i] = i == 0 ? false : sideSeeds[i];
            if (i != 0) {
                uint256 when = bound(timeSeeds[i], vault.votingStart(0), vault.roundEnd(0) - 1);
                if (when > at) at = when;
                vm.warp(at);
            }
            _voter(voters[i], stakes[i]);
            vm.prank(voters[i]);
            vault.vote(sides[i], stakes[i], bytes32(0));
        }
        _toEnd(0);
        for (uint256 i; i < 4; i++) {
            vm.prank(voters[i]);
            vault.withdraw(0, payable(voters[i]));
            assertEq(IERC20(jet).balanceOf(voters[i]), stakes[i]); // the raw stake always comes back in full
        }
        assertEq(IERC20(jet).balanceOf(address(vault)), 0);

        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        bool approved = outcome == ArcSatisfaction.Outcome.Approved;
        uint256 paid;
        for (uint256 i; i < 4; i++) {
            paid += voters[i].balance;
            if (voters[i].balance > 0) assertEq(sides[i], approved); // only the winning side is paid
        }
        if (outcome != ArcSatisfaction.Outcome.Void) {
            // Both outcomes pay the same 90%; only the team's 10% goes somewhere different.
            uint256 distributable = pot - pot / 10;
            assertLe(paid, distributable);
            assertLt(distributable - paid, 4); // floor dust is below one wei per voter
            assertEq(vault.teamCredit(), approved ? pot / 10 : 0);
            assertGe(address(vault).balance, vault.reserved() + vault.teamCredit());
        } else {
            assertEq(paid, 0);
            assertEq(address(vault).balance, pot); // nobody paid; the vault still holds the whole pot
        }
    }

    function testFuzzRejectedPayoutsNeverExceedThePot(
        uint256 potSeed,
        uint256[4] memory stakeSeeds,
        uint256[4] memory timeSeeds
    ) public {
        uint256 pot = bound(potSeed, 1, 500e18);
        _fundPot(pot);
        _toVoting(0);
        address[4] memory voters = [makeAddr("v0"), makeAddr("v1"), makeAddr("v2"), makeAddr("v3")];
        uint256[4] memory stakes;
        uint256 at = vault.votingStart(0);
        for (uint256 i; i < 4; i++) {
            // The first voter stakes at least the quorum at the opening second, so both quorum parts hold.
            stakes[i] = bound(stakeSeeds[i], i == 0 ? QUORUM : 1, 1_000_000e18);
            if (i != 0) {
                uint256 when = bound(timeSeeds[i], vault.votingStart(0), vault.roundEnd(0) - 1);
                if (when > at) at = when;
                vm.warp(at);
            }
            _voter(voters[i], stakes[i]);
            vm.prank(voters[i]);
            vault.vote(false, stakes[i], bytes32(0));
        }
        _toEnd(0);
        uint256 paid;
        for (uint256 i; i < 4; i++) {
            vm.prank(voters[i]);
            vault.withdraw(0, payable(voters[i]));
            paid += voters[i].balance;
            assertEq(IERC20(jet).balanceOf(voters[i]), stakes[i]); // the raw stake always comes back in full
        }
        uint256 distributable = pot - pot / 10; // the team's 10% left for the buyback budget
        assertLe(paid, distributable);
        assertLt(distributable - paid, 4); // floor dust is below one wei per voter
        assertEq(vault.reserved(), distributable - paid);
        assertGe(address(vault).balance, vault.reserved() + vault.teamCredit());
        assertEq(IERC20(jet).balanceOf(address(vault)), 0);
    }

    /// A pot under ten wei floors the team's share to zero. The factory refuses a zero donation, so
    /// settlement has to skip the call — otherwise `withdraw`, which settles a due round on its way,
    /// would revert and lock every voter's stake in that round for good.
    function testRejectedPotTooSmallForATeamShareStillSettles() public {
        _fundPot(9); // nine wei: 9 * 1000 / 10000 floors to zero
        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 2_000e18, bytes32(0));
        _toEnd(0);

        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Rejected));
        assertEq(vault.reserved(), 9); // nothing was carved out, so the voter is owed all of it
        assertEq(vault.payoutOf(0, alice), 9);

        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        assertEq(alice.balance, 9);
        assertEq(IERC20(jet).balanceOf(alice), 10_000e18);
        assertEq(vault.reserved(), 0);
    }

    /// A Rejected round still carves out the team's 10% — but it goes to the SPARK buyback budget
    /// instead of to the team, so the team is paid only when a round says people are satisfied.
    /// The burn is not immediate: the money joins the budget the keeper spends under its own
    /// minimum, its lagged average price and its per-call cap, exactly like the Approved 90%.
    function testRejectedSendsTheTeamShareToTheBuybackBudget() public {
        _fundPot(10e18);
        (, uint256 budgetBefore,,,,,) = launch.tokens(jet);

        _toVoting(0);
        vm.prank(alice);
        vault.vote(false, 3_000e18, keccak256("no roadmap"));
        vm.prank(bob);
        vault.vote(false, 1_000e18, keccak256("no updates"));
        _toEnd(0);

        vault.settle(0);
        (,,,,,,, ArcSatisfaction.Outcome outcome) = vault.rounds(0);
        assertEq(uint8(outcome), uint8(ArcSatisfaction.Outcome.Rejected));

        (, uint256 budgetAfter,,,,,) = launch.tokens(jet);
        assertEq(budgetAfter - budgetBefore, 1e18); // the team's 10%, now a buyback
        assertEq(vault.teamCredit(), 0); // and nothing the team can pull
        assertEq(vault.reserved(), 9e18); // the No voters still share the rest, on weight
        assertEq(vault.payoutOf(0, alice), 6.75e18);
        assertEq(vault.payoutOf(0, bob), 2.25e18);
        _assertSolvent(4_000e18);

        vm.prank(alice);
        vault.withdraw(0, payable(alice));
        vm.prank(bob);
        vault.withdraw(0, payable(bob));
        assertEq(alice.balance, 6.75e18);
        assertEq(bob.balance, 2.25e18);
        assertEq(vault.reserved(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(team.balance, 0);
    }
}
