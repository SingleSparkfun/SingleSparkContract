// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcLaunchV2Fixture} from "./ArcLaunchV2Fixture.sol";
import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";
import {ArcToken} from "../src/ArcLaunch.sol";
import {ArcRewards} from "../src/ArcRewards.sol";
import {ArcKeeperExecutor} from "../src/ArcKeeperExecutor.sol";

contract RejectingOperator {
    ArcKeeperExecutor executor;

    function bind(ArcKeeperExecutor executor_) external {
        executor = executor_;
    }

    function run(address target, bytes calldata data) external returns (bytes memory) {
        return executor.execute(target, data);
    }

    receive() external payable {
        revert();
    }
}

/// Tries to re-enter the executor from the gas forward it is being paid by.
contract ReentrantOperator {
    ArcKeeperExecutor executor;
    address target;
    bytes data;
    uint256 public forwards;
    bool public flushReverted;
    bool public executeReverted;

    function bind(ArcKeeperExecutor executor_, address target_, bytes calldata data_) external {
        executor = executor_;
        target = target_;
        data = data_;
    }

    receive() external payable {
        forwards++;
        (bool ok,) = address(executor).call(abi.encodeCall(ArcKeeperExecutor.flush, ()));
        flushReverted = !ok;
        (ok,) = address(executor).call(abi.encodeCall(ArcKeeperExecutor.execute, (target, data)));
        executeReverted = !ok;
    }
}

/// Consumes every unit of gas forwarded to it, so the transfer runs out of gas and reverts.
contract GasBurningOperator {
    receive() external payable {
        while (true) {
            assembly {
                pop(keccak256(0, 32))
            }
        }
    }
}

/// Claims to be the rewards contract of a real token; the factory's registry says otherwise.
contract FakeRewards {
    address public token;

    constructor(address token_) {
        token = token_;
    }

    function drain() external pure returns (uint256) {
        return 1;
    }
}

contract ArcKeeperExecutorTest is ArcLaunchV2Fixture {
    ArcKeeperExecutor executor;
    address owner = address(0x0a11);
    address operator = address(0x0be1);
    address stranger = address(0xbad);

    function setUp() public {
        _install(operator);
    }

    /// The executor must exist before the factory because `keeper` is immutable in the factory.
    function _install(address operator_) internal {
        executor = new ArcKeeperExecutor(owner, operator_, 2e18);
        keeper = address(executor); // the fixture passes `keeper` to the factory constructor
        _deploy(treasury);
        executor.configure(address(launch));
        vm.deal(address(executor), 0); // the fixture funds `keeper`; start every test from an empty reserve
    }

    function testParametersAndBinding() public view {
        assertEq(executor.KEEPER_EXECUTOR_VERSION(), 1);
        assertEq(executor.OPERATOR_GAS_TARGET(), 2e18);
        assertEq(executor.owner(), owner);
        assertEq(executor.operator(), operator);
        assertEq(address(executor.factory()), address(launch));
        assertEq(launch.keeper(), address(executor));
        (,, ArcRewards reward) = launch.terms(project);
        assertEq(reward.keeper(), address(executor));
    }

    function testConstructorAndConfigureValidation() public {
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        new ArcKeeperExecutor(address(0), operator, 2e18);
        ArcKeeperExecutor other = new ArcKeeperExecutor(owner, address(0), 2e18); // a zero operator is allowed: paused
        vm.prank(stranger);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        other.configure(address(launch));
        // This factory's keeper is `executor`, not `other`.
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        other.configure(address(launch));
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        other.configure(stranger); // no code
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.configure(address(launch)); // one shot
    }

    function testOwnerRotatesTheOperatorAndOwnershipMovesInTwoSteps() public {
        address next = address(0x0be2);
        vm.prank(stranger);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.setOperator(next);
        vm.prank(operator);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.setOperator(next); // the operator cannot entrench itself
        vm.prank(owner);
        executor.setOperator(next);
        assertEq(executor.operator(), next);
        vm.prank(owner);
        executor.setOperator(address(0)); // pause
        assertEq(executor.operator(), address(0));

        address multisig = address(0x5afe);
        vm.prank(stranger);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.transferOwnership(multisig);
        vm.prank(owner);
        executor.transferOwnership(multisig);
        assertEq(executor.owner(), owner); // nothing moves until the new owner accepts
        vm.prank(stranger);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.acceptOwnership();
        vm.prank(multisig);
        executor.acceptOwnership();
        assertEq(executor.owner(), multisig);
        assertEq(executor.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.setOperator(next);
    }

    /// Self, or the bound factory: `_forward` would call back into the executor or the factory on
    /// every execute, and `flush` would recurse until it ran out of gas. `execute` becomes impossible.
    function testTheExecutorAndItsFactoryAreRefusedAsOperator() public {
        vm.startPrank(owner);
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        executor.setOperator(address(executor));
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        executor.setOperator(address(launch));
        executor.setOperator(address(0)); // the pause stays allowed
        assertEq(executor.operator(), address(0));
        executor.setOperator(operator);
        vm.stopPrank();
        // The reserve still only ever moves to a plain operator.
        vm.deal(address(executor), 1e18);
        executor.flush();
        assertEq(operator.balance, 1e18);
    }

    /// Before `configure` the factory is unknown, so `setOperator` cannot refuse it yet.
    function testConfigureRefusesAFactoryThatIsAlreadyTheOperator() public {
        ArcKeeperExecutor other = new ArcKeeperExecutor(owner, address(0), 2e18);
        ArcLaunchV2 second = _newFactory(positionManager, address(other), treasury);
        vm.prank(owner);
        other.setOperator(address(second)); // no factory bound yet: allowed
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        other.configure(address(second));
        vm.prank(owner);
        other.setOperator(operator);
        other.configure(address(second));
        assertEq(address(other.factory()), address(second));
    }

    /// The executor tops its operator up to OPERATOR_GAS_TARGET while the factory tops the executor up to its
    /// KEEPER_GAS_TRIGGER; if the two differed the executor would hold the factory's gas or keep asking for more.
    function testConfigureRefusesAFactoryWithADifferentGasTrigger() public {
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        new ArcKeeperExecutor(owner, operator, 0);
        ArcKeeperExecutor other = new ArcKeeperExecutor(owner, operator, 1e18);
        ArcLaunchV2 second = _newFactory(positionManager, address(other), treasury);
        assertEq(second.KEEPER_GAS_TRIGGER(), 2e18);
        vm.expectRevert(ArcKeeperExecutor.InvalidConfiguration.selector);
        other.configure(address(second));
        ArcKeeperExecutor matching = new ArcKeeperExecutor(owner, operator, 2e18);
        ArcLaunchV2 third = _newFactory(positionManager, address(matching), treasury);
        matching.configure(address(third));
        assertEq(address(matching.factory()), address(third));
    }

    function testAnUnconfiguredExecutorAllowsNoTargetAtAll() public {
        ArcKeeperExecutor other = new ArcKeeperExecutor(owner, operator, 2e18);
        (,, ArcRewards reward) = launch.terms(project);
        assertFalse(other.isAllowedTarget(address(launch)));
        assertFalse(other.isAllowedTarget(address(reward)));
        assertFalse(other.isAllowedTarget(address(0)));
        vm.prank(operator);
        vm.expectRevert(ArcKeeperExecutor.TargetNotAllowed.selector);
        other.execute(address(launch), abi.encodeCall(ArcLaunchV2.collectFees, (project)));
    }

    function _burnCall(address token, uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(ArcLaunchV2.executeBurn, (token, amount, 1, vm.getBlockTimestamp() + 120));
    }

    function testOnlyTheOperatorExecutesAndOnlyAgainstRegisteredTargets() public {
        (,, ArcRewards reward) = launch.terms(project);
        assertTrue(executor.isAllowedTarget(address(launch)));
        assertTrue(executor.isAllowedTarget(address(reward)));
        assertFalse(executor.isAllowedTarget(stranger)); // no code
        assertFalse(executor.isAllowedTarget(project)); // a token is not a rewards contract
        FakeRewards fake = new FakeRewards(project);
        assertFalse(executor.isAllowedTarget(address(fake))); // the registry names the real one

        bytes memory collect = abi.encodeCall(ArcLaunchV2.collectFees, (project));
        vm.prank(stranger);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.execute(address(launch), collect);
        vm.prank(owner);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.execute(address(launch), collect); // owning the executor is not operating it

        vm.startPrank(operator);
        vm.expectRevert(ArcKeeperExecutor.TargetNotAllowed.selector);
        executor.execute(address(fake), abi.encodeCall(FakeRewards.drain, ()));
        vm.expectRevert(ArcKeeperExecutor.TargetNotAllowed.selector);
        executor.execute(jet, abi.encodeCall(IERC20.transfer, (operator, 1)));
        vm.expectRevert(ArcKeeperExecutor.InvalidCall.selector);
        executor.execute(address(launch), hex"001122"); // shorter than a selector
        vm.stopPrank();
    }

    function testKeeperActionsRunEndToEndThroughTheExecutor() public {
        launch.fundFees{value: 100e18}(project); // 83 USDC to PJT's buyback, 5 USDC to its rewards
        (,, ArcRewards reward) = launch.terms(project);
        uint256 supply = ArcToken(project).totalSupply();
        (, uint256 amount) = strategy.keeperSwapState(project, true);
        assertGt(amount, 0);

        // The old-style direct call is no longer authorized: the factory's keeper is the executor.
        vm.prank(operator);
        vm.expectRevert(ArcLaunchV2.Unauthorized.selector);
        launch.executeBurn(project, amount, 1, vm.getBlockTimestamp() + 120);

        vm.prank(operator);
        executor.execute(address(launch), _burnCall(project, amount));
        assertLt(ArcToken(project).totalSupply(), supply);

        vm.prank(operator);
        executor.execute(
            address(reward), abi.encodeCall(ArcRewards.buyOwnToken, (5e18, 1, vm.getBlockTimestamp() + 120))
        );
        assertGt(reward.available(), 0);
    }

    function testTargetRevertsBubbleWithTheirOwnSelector() public {
        launch.fundFees{value: 100e18}(project);
        (, uint256 amount) = strategy.keeperSwapState(project, true);
        vm.startPrank(operator);
        executor.execute(address(launch), _burnCall(project, amount));
        // Second burn inside the 180 s cooldown: the factory's NotDue must reach the caller unchanged.
        vm.expectRevert(ArcLaunchV2.NotDue.selector);
        executor.execute(address(launch), _burnCall(project, 1e18));
        vm.stopPrank();
    }

    function testRotationCutsOffTheOldOperatorImmediately() public {
        launch.fundFees{value: 100e18}(project);
        (, uint256 amount) = strategy.keeperSwapState(project, true);
        address next = address(0x0be2);
        vm.prank(owner);
        executor.setOperator(next);
        vm.prank(operator);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.execute(address(launch), _burnCall(project, amount));
        uint256 supply = ArcToken(project).totalSupply();
        vm.prank(next);
        executor.execute(address(launch), _burnCall(project, amount));
        assertLt(ArcToken(project).totalSupply(), supply);

        vm.prank(owner);
        executor.setOperator(address(0));
        vm.prank(next);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.execute(address(launch), abi.encodeCall(ArcLaunchV2.collectFees, (project)));
    }

    function testFactoryTopUpReachesAnOperatorThatNeedsGas() public {
        vm.deal(operator, 0.5e18); // exists and is below the 2 USDC target
        launch.fundKeeperGas{value: 5e18}(); // credits operations, then tops the keeper up once (0.25 USDC max)
        assertEq(operator.balance, 0.75e18);
        assertEq(address(executor).balance, 0);
        // The executor is still empty, so the factory keeps offering gas until the daily limit.
        assertEq(launch.keeperGasAvailable(), 0.25e18);
    }

    function testTopUpIsHeldWhileTheOperatorHasEnoughGas() public {
        vm.deal(operator, 3e18);
        launch.fundKeeperGas{value: 5e18}();
        assertEq(operator.balance, 3e18);
        assertEq(address(executor).balance, 0.25e18);
        // Held reserve counts as the keeper's balance: repeated top-ups stop once it reaches the trigger.
        for (uint256 i; i < 7; i++) {
            launch.topUpKeeper();
        }
        assertEq(address(executor).balance, 2e18);
        assertEq(launch.keeperGasAvailable(), 0);
        assertEq(launch.topUpKeeper(), 0);
    }

    function testHeldReserveFollowsTheOperatorOnTheNextExecuteOrFlush() public {
        vm.deal(operator, 3e18);
        launch.fundKeeperGas{value: 5e18}();
        assertEq(address(executor).balance, 0.25e18);
        vm.deal(operator, 1.9e18); // the operator spent gas
        vm.prank(operator);
        // collectFees itself makes the factory top the keeper up once more (+0.25), so 0.5 is held in total.
        executor.execute(address(launch), abi.encodeCall(ArcLaunchV2.collectFees, (project)));
        assertEq(operator.balance, 2e18); // only up to the target: 0.1 of the 0.5 moved
        assertEq(address(executor).balance, 0.4e18);

        // After a rotation the reserve stays with the executor and serves the new operator.
        address next = address(0x0be2);
        vm.prank(owner);
        executor.setOperator(next);
        vm.prank(stranger); // anyone may sponsor the transfer
        executor.flush();
        assertEq(next.balance, 0.4e18);
        assertEq(address(executor).balance, 0);
    }

    function testAnEmptyOperatorAccountNeverBreaksTheThirtyThousandGasTopUp() public {
        assertEq(operator.balance, 0); // may not exist yet: a transfer would cost 25,000 extra gas
        launch.fundKeeperGas{value: 5e18}();
        assertEq(address(executor).balance, 0.25e18); // accepted and held, not reverted
        assertEq(operator.balance, 0);
        executor.flush(); // with a normal gas limit the reserve moves
        assertEq(operator.balance, 0.25e18);
    }

    function testPausedOrRejectingOperatorNeverBlocksAnything() public {
        vm.prank(owner);
        executor.setOperator(address(0));
        launch.fundKeeperGas{value: 5e18}();
        assertEq(address(executor).balance, 0.25e18);
        executor.flush(); // nothing to do, no revert

        RejectingOperator rejecting = new RejectingOperator();
        rejecting.bind(executor);
        vm.deal(address(rejecting), 1e18);
        vm.prank(owner);
        executor.setOperator(address(rejecting));
        executor.flush(); // the transfer fails quietly
        assertEq(address(executor).balance, 0.25e18);
        // execute still works; collectFees tops the keeper up (+0.25) and the failed forward keeps it here
        rejecting.run(address(launch), abi.encodeCall(ArcLaunchV2.collectFees, (project)));
        assertEq(address(executor).balance, 0.5e18);
        launch.topUpKeeper(); // and the factory's own top-up still succeeds
        assertEq(address(executor).balance, 0.75e18);
    }

    /// The forward is the only call the executor makes into an operator, and the operator is inside
    /// `flush`'s / `execute`'s reentrancy guard while it runs.
    function testAReentrantOperatorGainsNothingBeyondTheGasTarget() public {
        ReentrantOperator reentrant = new ReentrantOperator();
        reentrant.bind(executor, address(launch), abi.encodeCall(ArcLaunchV2.collectFees, (project)));
        vm.prank(owner);
        executor.setOperator(address(reentrant));
        vm.deal(address(executor), 3e18);

        vm.prank(stranger); // anybody may sponsor the forward
        executor.flush();
        assertEq(reentrant.forwards(), 1);
        assertTrue(reentrant.flushReverted());
        assertTrue(reentrant.executeReverted());
        // Capped at OPERATOR_GAS_TARGET however many times it calls back, and the rest stays here.
        assertEq(address(reentrant).balance, 2e18);
        assertEq(address(executor).balance, 1e18);

        // A second forward sends nothing: the operator is already at the target.
        executor.flush();
        assertEq(address(reentrant).balance, 2e18);
        assertEq(address(executor).balance, 1e18);
        assertEq(reentrant.forwards(), 1);
    }

    function testAnOperatorThatBurnsAllGasCannotBlockTheFactoryTopUp() public {
        GasBurningOperator burner = new GasBurningOperator();
        vm.deal(address(burner), 1 wei); // exists with a balance, so `receive` does attempt a forward
        vm.prank(owner);
        executor.setOperator(address(burner));

        launch.fundKeeperGas{value: 5e18}();
        // The forward ran out of gas and was ignored; the factory's 30,000 gas transfer still landed.
        assertEq(address(executor).balance, 0.25e18);
        assertEq(address(burner).balance, 1 wei);
        assertGt(launch.topUpKeeper(), 0);
        assertEq(address(executor).balance, 0.5e18);
        assertEq(address(burner).balance, 1 wei);
    }

    /// The permissionless top-up is the one call the backend sends direct; it must also work wrapped.
    function testTheGasTopUpWorksThroughExecuteAndEmitsExecuted() public {
        vm.deal(operator, 0.5e18);
        launch.fundKeeperGas{value: 5e18}();
        assertEq(operator.balance, 0.75e18);

        vm.expectEmit(true, true, true, true, address(executor));
        emit ArcKeeperExecutor.Executed(address(launch), ArcLaunchV2.topUpKeeper.selector);
        vm.prank(operator);
        executor.execute(address(launch), abi.encodeCall(ArcLaunchV2.topUpKeeper, ()));
        assertEq(operator.balance, 1e18); // the wrapped top-up reached the operator
        assertEq(address(executor).balance, 0);
    }

    /// `launch` is permissionless and single-sided, so it is reachable but pointless: nothing moves.
    function testLaunchingThroughTheExecutorMovesNoFunds() public {
        uint256 executorBalance = address(executor).balance;
        uint256 launchBalance = address(launch).balance;
        uint256 operatorBalance = operator.balance;
        vm.prank(operator);
        address vault = abi.decode(executor.execute(address(launch), abi.encodeCall(ArcLaunchV2.createProjectTreasury, ())), (address));
        vm.prank(operator);
        bytes memory result = executor.execute(
            address(launch), abi.encodeCall(ArcLaunchV2.launch, ("Exec", "EXE", "", 10_000, 10_000, vault))
        );
        address token = abi.decode(result, (address));
        assertTrue(token != address(0));
        assertEq(address(executor).balance, executorBalance);
        assertEq(address(launch).balance, launchBalance);
        assertEq(operator.balance, operatorBalance);
        // The whole supply went into the locked single-sided LP, as for any other launch.
        assertEq(IERC20(token).balanceOf(address(executor)), 0);
        assertEq(IERC20(token).balanceOf(operator), 0);
        assertEq(IERC20(token).balanceOf(owner), 0);
    }

    function testAPendingOwnershipTransferCanBeCancelled() public {
        address multisig = address(0x5afe);
        vm.startPrank(owner);
        executor.transferOwnership(multisig);
        assertEq(executor.pendingOwner(), multisig);
        executor.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(executor.pendingOwner(), address(0));
        vm.prank(multisig);
        vm.expectRevert(ArcKeeperExecutor.Unauthorized.selector);
        executor.acceptOwnership();
        assertEq(executor.owner(), owner);
    }

    function testOwnerHasNoPathToTheReserve() public {
        vm.deal(operator, 3e18);
        launch.fundKeeperGas{value: 5e18}();
        uint256 held = address(executor).balance;
        vm.startPrank(owner);
        // There is no withdraw function; the only lever is the operator, capped by the 2 USDC target.
        executor.setOperator(owner);
        executor.flush();
        vm.stopPrank();
        assertLe(owner.balance, 2e18);
        assertEq(owner.balance + address(executor).balance, held);
    }
}
