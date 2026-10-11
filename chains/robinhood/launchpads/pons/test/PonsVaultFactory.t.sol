// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PonsVaultFactory} from "../PonsVaultFactory.sol";
import {PonsGameplayVault} from "../PonsGameplayVault.sol";
import {IPonsLaunch} from "../IPonsLaunch.sol";
import {GameplayPolicy} from "../../../../evm/gameplay/IGameplayProtocol.sol";

contract TestPonsEscrow {
    mapping(address => uint256) public balanceOf;
    function credit(address recipient) external payable { balanceOf[recipient] += msg.value; }
    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender]; balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
    }
}
contract TestPonsToken is ERC20 { constructor() ERC20("Fixture", "FIX") {} }
contract TestPonsCurve {
    bool public graduated;
    address public immutable recipient;
    TestPonsEscrow public immutable escrow;
    constructor(address recipient_, TestPonsEscrow escrow_) { recipient = recipient_; escrow = escrow_; }
    function sweepFees(uint256) external {
        require(msg.sender == recipient && !graduated);
        escrow.credit{value: address(this).balance}(recipient);
    }
    function graduate() external { graduated = true; }
    receive() external payable {}
}
contract TestPonsLaunch {
    TestPonsEscrow public immutable feeEscrow = new TestPonsEscrow();
    bool public allowed = true;
    uint256 public fee;
    bytes32 public constant ECONOMICS = keccak256("economics");
    address public lastExemption;
    address public lastRecipient;
    function canLaunch(address) external view returns (bool) { return allowed; }
    function setAllowed(bool value) external { allowed = value; }
    function setFee(uint256 value) external { fee = value; }
    function launchToken(IPonsLaunch.TokenParams calldata p, uint256 config, address pair, address[] calldata exemptions)
        external payable returns (address token, address curve)
    {
        require(allowed && msg.value == fee && p.expectedEconomics == ECONOMICS && config == 0 && pair == address(0));
        require(!p.buybackEnabled);
        lastExemption = exemptions[0]; lastRecipient = p.creatorFeeRecipient;
        token = address(new TestPonsToken());
        curve = address(new TestPonsCurve(p.creatorFeeRecipient, feeEscrow));
    }
}
contract PonsVaultFactoryTest is Test {
    TestPonsLaunch source;
    PonsVaultFactory factory;
    address constant OWNER = address(0x1234);
    address constant OTHER = address(0x5678);
    address constant TREASURY = address(0x9999);
    function setUp() public {
        vm.chainId(46630);
        source = new TestPonsLaunch();
        factory = new PonsVaultFactory(address(this), OTHER, TREASURY, IPonsLaunch(address(source)));
    }
    function draft() internal view returns (IPonsLaunch.TokenParams memory p) {
        p.name = "Test Project"; p.symbol = "TEST"; p.creatorTaxBps = 200;
        p.expectedEconomics = source.ECONOMICS(); p.salt = keccak256("project");
        p.creatorFeeRecipient = OTHER;
    }
    function launch() internal returns (address token, address curve, PonsGameplayVault vault) {
        IPonsLaunch.TokenParams memory p = draft();
        vm.prank(OWNER);
        address v; (token, curve, v) = factory.launch(p);
        vault = PonsGameplayVault(payable(v));
    }
    function testAtomicLaunchBindsOwnerAndIgnoresExternalRecipient() public {
        address predicted = factory.predictLaunchVault(OWNER, draft().salt);
        (address token, address curve, PonsGameplayVault vault) = launch();
        assertEq(address(vault), predicted); assertEq(vault.owner(), OWNER);
        assertEq(vault.projectToken(), token); assertEq(vault.asset(), address(0));
        assertEq(address(factory.curveOf(token)), curve);
        assertEq(factory.vaultOf(OWNER, token), predicted); assertTrue(factory.isVault(predicted));
        assertEq(source.lastRecipient(), predicted); assertEq(source.lastExemption(), OWNER);
        assertEq(factory.DELAY(), 48 hours);
        vm.expectRevert(); vault.initialize(OTHER, token, address(0), new GameplayPolicy[](0));
    }
    function testRevenueCollectionIsPermissionlessAndBudgetedExactlyOnce() public {
        (,address curve, PonsGameplayVault vault) = launch();
        vm.deal(curve, 100 ether);
        vm.prank(OTHER); vault.collectRevenue();
        assertEq(address(vault).balance, 100 ether); assertEq(vault.received(), 100 ether);
        assertEq(vault.platformBudget(), 10 ether); assertEq(vault.claimBudget(), 0.5 ether);
        assertEq(vault.unallocated(), 89.5 ether);
        vault.collectRevenue(); assertEq(vault.received(), 100 ether);
        assertEq(OTHER.balance, 0); assertEq(OWNER.balance, 0);
        vault.settlePlatform(); assertEq(TREASURY.balance, 10 ether);
    }
    function testGraduatedRevenueAndDirectDepositsStillReachSameBudget() public {
        (,address curve, PonsGameplayVault vault) = launch();
        TestPonsCurve(payable(curve)).graduate();
        vm.deal(address(this), 2 ether);
        source.feeEscrow().credit{value: 1 ether}(address(vault));
        vault.collectRevenue();
        vault.deposit{value: 1 ether}(1 ether);
        assertEq(vault.received(), 2 ether); assertEq(vault.unallocated(), 1.79 ether);
    }
    function testSameSaltCannotDuplicateProjectAndOtherOwnerCannotStealIt() public {
        IPonsLaunch.TokenParams memory p = draft();
        address expected = factory.predictLaunchVault(OWNER, p.salt);
        vm.prank(OTHER); (,,address otherVault) = factory.launch(p);
        assertTrue(otherVault != expected);
        (,,PonsGameplayVault vault) = launch(); assertEq(address(vault), expected);
        vm.expectRevert(); vm.prank(OWNER); factory.launch(p);
    }
    function testRevertedLaunchRollsBackVaultAndCanBeRetried() public {
        IPonsLaunch.TokenParams memory p = draft(); p.expectedEconomics = bytes32(uint256(1));
        address predicted = factory.predictLaunchVault(OWNER, p.salt);
        vm.expectRevert(); vm.prank(OWNER); factory.launch(p);
        assertEq(predicted.code.length, 0);
        (,,PonsGameplayVault vault) = launch(); assertEq(address(vault), predicted);
    }
    function testRefusesUncommittedEconomicsBuybackPauseAndChangedCode() public {
        IPonsLaunch.TokenParams memory p = draft(); p.expectedEconomics = bytes32(0);
        vm.expectRevert(); factory.launch(p);
        p = draft(); p.buybackEnabled = true; vm.expectRevert(); factory.launch(p);
        p = draft(); source.setAllowed(false); vm.expectRevert(); factory.launch(p);
        source.setAllowed(true); factory.pause(); vm.expectRevert(); factory.launch(p);
        vm.etch(address(source), hex"00"); vm.expectRevert(); factory.checkPons();
    }
    function testLaunchFeeCannotSilentlyIncrease() public {
        source.setFee(1 ether);
        IPonsLaunch.TokenParams memory p = draft();
        vm.expectRevert(); vm.prank(OWNER); factory.launch(p);
        vm.deal(OWNER, 1 ether); vm.prank(OWNER); factory.launch{value: 1 ether}(p);
        assertEq(address(factory).balance, 0);
    }
    function testMainnetDeploymentIsNotAuthorized() public {
        vm.chainId(4663); vm.expectRevert();
        new PonsVaultFactory(address(this), OTHER, TREASURY, IPonsLaunch(address(source)));
    }
}
