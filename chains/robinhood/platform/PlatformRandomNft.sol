// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPlatformNft} from "./IPlatformNft.sol";

/// A separate eight-grade collection; legacy four-quality NFTs keep their original meaning.
contract PlatformRandomNft is ERC721Enumerable {
    uint256 public constant MAX_SUPPLY = 100_000;
    address public immutable issuer;
    uint256 public mintedSupply;
    mapping(uint256 => uint8) private _quality;
    string[8] public artworkUris;
    error Invalid();

    constructor(string[8] memory artwork) ERC721("SingleSpark Random NFT", "SSRNFT") {
        if (block.chainid != 46630) revert Invalid();
        issuer = msg.sender;
        for (uint256 i; i < 8; ++i) {
            if (bytes(artwork[i]).length == 0 || bytes(artwork[i]).length > 2048) revert Invalid();
        }
        artworkUris = artwork;
    }
    function mint(address recipient, uint8 quality) external returns (uint256 id) {
        if (msg.sender != issuer || recipient == address(0) || quality < 1 || quality > 8 || mintedSupply >= MAX_SUPPLY) revert Invalid();
        id = ++mintedSupply; _quality[id] = quality; _safeMint(recipient, id);
    }
    function qualityOf(uint256 tokenId) external view returns (uint8) { _requireOwned(tokenId); return _quality[tokenId]; }
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IPlatformNft).interfaceId || super.supportsInterface(interfaceId);
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string[8] memory names = [string("Ember Seed"), "Verdant Flame", "Azure Heart", "Amethyst Soul", "Solar Crown", "Crimson Phoenix", "Astral Flame", "Genesis Core"];
        uint8 quality = _quality[tokenId];
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(
            '{"name":"SingleSpark NFT #', Strings.toString(tokenId), '","image":"', artworkUris[quality - 1],
            '","attributes":[{"trait_type":"Grade","value":', Strings.toString(quality),
            '},{"trait_type":"Form","value":"', names[quality - 1], '"}]}'
        ))));
    }
}
