import assert from 'node:assert/strict';
import { getAddress } from 'viem';

export function nftDeploymentReportName({ random, immediateClaims }) {
  assert(!immediateClaims || random, 'Immediate claims require random NFT issuance');
  return immediateClaims ? 'nft-random-immediate-vault.json' : random ? 'nft-random-vault.json' : 'nft-vault.json';
}

export function randomNftConfig(value) {
  assert.equal(value?.chainId, 46630, 'Random NFT issuance is testnet-only');
  const array = (items, label, maximum) => {
    assert(Array.isArray(items) && items.length === 8, `${label}: supply all eight values`);
    assert(items.every(item => Number.isInteger(item) && item > 0 && item <= maximum), `${label}: positive integers required`);
    return items;
  };
  const probabilities = array(value.probabilitiesBps, 'probabilitiesBps', 10_000);
  assert.equal(probabilities.reduce((sum, item) => sum + item, 0), 10_000, 'Probabilities must total 10000 basis points');
  const weights = array(value.gradeWeights, 'gradeWeights', 65_535);
  const artwork = value.artworkUris;
  assert(Array.isArray(artwork) && artwork.length === 8 && artwork.every(uri => typeof uri === 'string' && uri.length <= 2048
    && /^(?:ipfs:\/\/|https:\/\/)[a-zA-Z0-9:/._%#?&=+~-]+$/.test(uri)), 'Supply eight published artwork URIs');
  assert(typeof value.requestFeeWei === 'string' && /^(0|[1-9]\d*)$/.test(value.requestFeeWei)
    && BigInt(value.requestFeeWei) < 2n ** 256n, 'Supply explicit requestFeeWei');
  const relayer = getAddress(value.relayerAddress);
  assert.notEqual(relayer, '0x0000000000000000000000000000000000000000', 'Relayer address required');
  return { probabilities, weights, artwork, requestFeeWei: BigInt(value.requestFeeWei), relayer };
}
