// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {NativeRevenueSplitter} from "../src/NativeRevenueSplitter.sol";
interface Vm {function deal(address,uint256) external; function prank(address) external;}
contract RejectNative {receive() external payable {revert();}}
contract NativeRevenueSplitterTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testAtomicDistributionAuthorizationAndReplay() public {
        vm.deal(address(this),10 ether);
        NativeRevenueSplitter splitter=new NativeRevenueSplitter(address(this));
        address payable[] memory recipients=new address payable[](2);
        recipients[0]=payable(address(0x111));recipients[1]=payable(address(0x222));
        uint256[] memory amounts=new uint256[](2);amounts[0]=0.7 ether;amounts[1]=0.3 ether;
        bytes32 id=keccak256("income-1");
        splitter.distribute{value:1 ether}(id,recipients,amounts);
        assert(address(0x111).balance==0.7 ether&&address(0x222).balance==0.3 ether);
        assert(address(splitter).balance==0&&splitter.executed(id));
        (bool replay,)=address(splitter).call{value:1 ether}(abi.encodeCall(splitter.distribute,(id,recipients,amounts)));
        assert(!replay&&address(0x111).balance==0.7 ether);
        vm.prank(address(0x333));
        (bool unauthorized,)=address(splitter).call(abi.encodeCall(splitter.distribute,(keccak256("income-2"),recipients,amounts)));
        assert(!unauthorized);
        recipients[1]=payable(address(new RejectNative()));
        bytes32 second=keccak256("income-3");
        (bool partialSuccess,)=address(splitter).call{value:1 ether}(abi.encodeCall(splitter.distribute,(second,recipients,amounts)));
        assert(!partialSuccess&&!splitter.executed(second)&&address(0x111).balance==0.7 ether);
    }
}
