export function claimTypedData(vault, request) {
  return { domain: { name: 'SingleSpark Gameplay', version: '1', chainId: 46630, verifyingContract: vault },
    primaryType: 'GameplayClaim', types: { GameplayClaim: [
      ['caller','address'], ['pluginId','bytes32'], ['amount','uint256'], ['minimumOutput','uint256'], ['reward','uint256'],
      ['deadline','uint256'], ['nonce','uint256'], ['policyRevision','uint256'], ['registryRevision','uint256'], ['dataHash','bytes32'],
    ].map(([name,type]) => ({ name, type })) }, message: request };
}
