// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPlatformNft} from "./IPlatformNft.sol";

/// Immutable-quality platform collection. Issuance is controlled by the factory's fixed 48-hour queue.
contract PlatformNft is ERC721Enumerable {
    uint256 public constant MAX_SUPPLY = 10_000;
    address public immutable issuer;
    uint256 public mintedSupply;
    mapping(uint256 => uint8) private _quality;
    error Invalid();
    constructor(address issuer_) ERC721("SingleSpark NFT", "SSNFT") {
        if (block.chainid != 46630 || issuer_ != msg.sender) revert Invalid();
        issuer = issuer_;
    }
    function mint(address recipient, uint8 quality) external returns (uint256 id) {
        if (msg.sender != issuer || recipient == address(0) || quality < 1 || quality > 4 || mintedSupply >= MAX_SUPPLY) revert Invalid();
        id = ++mintedSupply; _quality[id] = quality; _safeMint(recipient, id);
    }
    function qualityOf(uint256 tokenId) external view returns (uint8) { _requireOwned(tokenId); return _quality[tokenId]; }
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IPlatformNft).interfaceId || super.supportsInterface(interfaceId);
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory id = Strings.toString(tokenId);
        string[4] memory names = [string("Common"), "Rare", "Epic", "Legendary"];
        string memory quality = names[_quality[tokenId] - 1];
        string memory svg = string.concat('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 480"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#242424"/><stop offset="1" stop-color="#555"/></linearGradient></defs><rect width="400" height="480" rx="24" fill="#151515"/><rect x="16" y="16" width="368" height="448" rx="16" fill="url(#g)" stroke="#888"/><g fill="#fafafa" font-family="sans-serif"><text x="36" y="60" font-size="14">SINGLESPARK / ROBINHOOD TESTNET</text><text x="200" y="245" text-anchor="middle" font-size="52" font-weight="700">SPARK</text><text x="36" y="410" font-size="24">#', id, '</text><text x="364" y="410" text-anchor="end" font-size="20">', quality, '</text></g></svg>');
        string memory metadata = string.concat('{"name":"SingleSpark NFT #', id, '","description":"SingleSpark platform participation NFT on Robinhood Testnet. Quality is immutable. Issuance has a 48-hour on-chain delay; random paid and social claims are not enabled.","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '","attributes":[{"trait_type":"Quality","value":"', quality, '"}]}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(metadata)));
    }
}
