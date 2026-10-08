// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ArgusProjectTreasury,ArgusSatisfaction} from "../src/ArgusGovernance.sol";
import {ArcProjectTreasury,IProjectTreasuryFactory} from "../src/ArcProjectTreasury.sol";

/// Explicit test stand-in; standard Anvil does not implement Arc's native-USDC precompile.
contract ArgusTestQuote is ERC20 {
    constructor() ERC20("Test USDC","USDC") {}
    function decimals() public pure override returns(uint8){return 6;}
    function mint(address to,uint256 amount) external {_mint(to,amount);}
}
contract ArgusTestToken is ERC20 {
    constructor() ERC20("Test token","TST"){_mint(msg.sender,1_000_000_000e18);}
}
contract ArgusTestFactory {
    address public platformToken; address public operations; address public community;
    uint256 public returned6;
    function setup(address token,address vault,address project) external {platformToken=token;operations=vault;community=project;}
    function terms(address) external view returns(uint24,address,address){return(10000,community,address(this));}
    function bind(ArgusProjectTreasury vault,address token) external{vault.bind(token);}
    function operationsClaimable() external pure returns(uint256){return 0;}
    function claimOperations() external pure {}
    function fundPlatformBuybackUsdc6(uint256 amount) external {
        require(msg.sender==operations);
        ArgusTestQuote(0x3600000000000000000000000000000000000000).transferFrom(msg.sender,address(this),amount);returned6+=amount;
    }
}
contract ArgusGovernanceTest is Test {
    ArgusTestQuote q;ArgusTestToken token;ArgusTestToken spark;ArgusTestFactory factory;
    ArgusProjectTreasury project;ArgusSatisfaction platform;
    address team=address(0x7000);address voter=address(0x8000);
    function setUp() public {
        vm.warp(1000);ArgusTestQuote mock=new ArgusTestQuote();vm.etch(0x3600000000000000000000000000000000000000,address(mock).code);
        q=ArgusTestQuote(0x3600000000000000000000000000000000000000);token=new ArgusTestToken();spark=new ArgusTestToken();factory=new ArgusTestFactory();
        project=new ArgusProjectTreasury(IProjectTreasuryFactory(address(factory)),address(this),team);
        platform=new ArgusSatisfaction(team,7 days,7 days-1 hours,10_000_000e18);
        factory.setup(address(spark),address(platform),address(project));factory.bind(project,address(token));platform.configure(address(factory));
    }
    function testProjectUSDC6ApprovedOnlyAndStakeRecovery() public {
        q.mint(address(project),300e6);
        assertEq(project.available(),300e18);
        vm.expectRevert(ArcProjectTreasury.Invalid.selector);project.propose(ArcProjectTreasury.Service.Boost,1e18+1,bytes32(uint256(1)));
        uint256 id=project.propose(ArcProjectTreasury.Service.TokenInfo,299e18,bytes32(uint256(1)));
        token.transfer(voter,10_000_000e18);vm.startPrank(voter);token.approve(address(project),10_000_000e18);project.vote(id,true,10_000_000e18);vm.stopPrank();
        vm.prank(team);vm.expectRevert(ArcProjectTreasury.NotReady.selector);project.claim(id);
        vm.warp(block.timestamp+7 days);project.settle(id);vm.prank(team);project.claim(id);
        assertEq(q.balanceOf(team),299e6);assertEq(q.balanceOf(address(project)),1e6);
        vm.prank(voter);project.withdrawStake(id);assertEq(token.balanceOf(voter),10_000_000e18);
        vm.expectRevert(ArcProjectTreasury.Invalid.selector);project.propose(ArcProjectTreasury.Service.TokenInfo,1e18,bytes32(uint256(1)));
    }
    function testPlatformRejectedUSDC6ReturnsTeamBudgetAndPaysWinners() public {
        q.mint(address(platform),100_000_003);spark.transfer(voter,10_000_000e18);
        uint256 round=platform.currentRound();vm.warp(platform.votingStart(round));vm.startPrank(voter);spark.approve(address(platform),10_000_000e18);platform.vote(false,10_000_000e18,bytes32(0));vm.stopPrank();
        vm.warp(platform.roundEnd(round));platform.settle(round);
        assertEq(factory.returned6(),10_000_000);assertEq(q.balanceOf(address(factory)),10_000_000);
        vm.prank(voter);platform.withdraw(round,payable(voter));assertEq(q.balanceOf(voter),90_000_003);assertEq(spark.balanceOf(voter),10_000_000e18);
        assertEq(q.balanceOf(address(platform)),0);assertEq(platform.reserved(),0);
    }
}
