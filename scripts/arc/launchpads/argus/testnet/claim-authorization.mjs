export function claimTypedData(vault, request) {
  return { domain: { name: 'SingleSpark Argus Claim', version: '1', chainId: 5042002, verifyingContract: vault },
    primaryType: 'Claim', types: { Claim: [
      ['caller','address'], ['bucket','uint8'], ['target','address'], ['amount','uint256'], ['minimum','uint256'], ['deadline','uint256'],
      ['nonce','uint256'], ['revision','uint256'], ['implementation','address'], ['reward','uint256'], ['recipientsHash','bytes32'],
    ].map(([name,type]) => ({ name, type })) }, message: request };
}
