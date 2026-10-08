// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ArgusCustodyRouter} from "../src/ArgusCustodyRouter.sol";
import {ArgusTestQuote, ArgusTestToken} from "./ArgusGovernance.t.sol";

contract ArgusIndependentWalletsTest is Test {
    function testNoVotingReservesStayInProjectWalletAndPlatformIncomeGoesToTeam() public {
        vm.chainId(5042);
        address portal = 0xB021Be536808f551b31789422Fd28a6c9c6e97Da;
        address quote = 0x3600000000000000000000000000000000000000;
        address custody = address(0xc000);
        address team = address(0x7000);
        address owner = address(0xa000);
        ArgusTestToken spark = new ArgusTestToken();
        ArgusTestToken meme = new ArgusTestToken();
        ArgusTestQuote mock = new ArgusTestQuote();
        vm.etch(quote, address(mock).code);
        vm.etch(portal, hex"00");
        vm.mockCall(portal,abi.encodeWithSignature("poolManager()"),abi.encode(address(0x100)));
        vm.mockCall(portal,abi.encodeWithSignature("launches(address)",address(spark)),
            abi.encode(custody,int24(0),true,address(0x101),address(0x102),address(0x103),uint16(300),uint16(300),uint256(1),int24(200),quote));
        vm.mockCall(portal,abi.encodeWithSignature("launches(address)",address(meme)),
            abi.encode(owner,int24(0),true,address(0x101),address(0x102),address(0x103),uint16(300),uint16(300),uint256(2),int24(200),quote));
        ArgusCustodyRouter router = new ArgusCustodyRouter(custody,address(spark),team,false);
        vm.prank(owner);
        assertEq(router.register(address(meme),address(0xa1)),owner);
        assertFalse(router.governanceEnabled());
        assertEq(router.community(address(meme)),owner);
        assertEq(owner.code.length,0);
        ArgusTestQuote(quote).mint(owner,5e6);
        vm.startPrank(owner);
        ArgusTestQuote(quote).approve(address(router),5e6);
        vm.expectRevert(ArgusCustodyRouter.Invalid.selector);
        router.fundTreasury(address(meme),false,4e6);
        vm.expectRevert(ArgusCustodyRouter.Invalid.selector);
        router.fundTreasury(address(spark),true,1e6);
        router.fundTreasury(address(meme),true,1e6);
        vm.stopPrank();
        assertEq(ArgusTestQuote(quote).balanceOf(owner),4e6);
        assertEq(ArgusTestQuote(quote).balanceOf(team),1e6);
        assertEq(ArgusTestQuote(quote).balanceOf(address(router)),0);
    }
    function testEachWalletFundsAndDistributesOnlyItsOwnProject() public {
        vm.chainId(5042);
        address portal = 0xB021Be536808f551b31789422Fd28a6c9c6e97Da;
        address quote = 0x3600000000000000000000000000000000000000;
        address team = address(0x7000);
        address a = address(0xa000);
        address b = address(0xb000);
        ArgusTestToken spark = new ArgusTestToken();
        ArgusTestToken one = new ArgusTestToken();
        ArgusTestToken two = new ArgusTestToken();
        ArgusTestQuote mock = new ArgusTestQuote();
        vm.etch(quote,address(mock).code);
        vm.etch(portal,hex"00");
        vm.mockCall(portal,abi.encodeWithSignature("poolManager()"),abi.encode(address(0x100)));
        address[3] memory tokens = [address(spark),address(one),address(two)];
        address[3] memory owners = [team,a,b];
        for (uint256 i; i<3; i++) {
            vm.mockCall(portal,abi.encodeWithSignature("launches(address)",tokens[i]),
                abi.encode(owners[i],int24(0),true,address(0x101),address(0x102),address(0x103),uint16(100),uint16(100),uint256(1),int24(200),quote));
        }
        ArgusCustodyRouter router = new ArgusCustodyRouter(team,address(spark),address(this),true);
        vm.prank(a);address vaultA = router.register(address(one),address(0xa1));
        vm.prank(b);router.register(address(two),address(0xb1));
        assertEq(router.projectOf(a),address(one));
        assertEq(router.projectOf(b),address(two));
        ArgusTestQuote(quote).mint(a,4e6);
        vm.startPrank(a);
        ArgusTestQuote(quote).approve(address(router),4e6);
        vm.expectRevert(ArgusCustodyRouter.Invalid.selector);
        router.fundTreasury(address(two),false,4e6);
        router.fundTreasury(address(one),false,4e6);
        vm.stopPrank();
        assertEq(ArgusTestQuote(quote).balanceOf(vaultA),4e6);
        one.transfer(a,1000e18);two.transfer(b,1000e18);
        address[] memory recipients = new address[](100);
        for(uint256 i;i<100;i++) recipients[i]=address(uint160(0x100000+i));
        vm.startPrank(a);
        one.approve(address(router),1000e18);
        vm.expectRevert(ArgusCustodyRouter.Invalid.selector);
        router.distribute(address(two),0,recipients);
        router.distribute(address(one),0,recipients);
        vm.expectRevert(ArgusCustodyRouter.Invalid.selector);
        router.distribute(address(one),0,recipients);
        vm.stopPrank();
        vm.startPrank(b);
        two.approve(address(router),1000e18);
        router.distribute(address(two),0,recipients);
        vm.stopPrank();
        assertEq(router.totalPaid(address(one)),100);assertEq(router.totalPaid(address(two)),100);
        assertEq(one.balanceOf(a),0);assertEq(two.balanceOf(b),0);
        for(uint256 i;i<100;i++) {assertEq(one.balanceOf(recipients[i]),10e18);assertEq(two.balanceOf(recipients[i]),10e18);}
    }
}
