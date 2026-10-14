import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomNftConfig, nftDeploymentReportName } from './random-nft-config.mjs';

test('keeps immediate-claim deployments separate from both legacy reports', () => {
  assert.equal(nftDeploymentReportName({random:false,immediateClaims:false}), 'nft-vault.json');
  assert.equal(nftDeploymentReportName({random:true,immediateClaims:false}), 'nft-random-vault.json');
  assert.equal(nftDeploymentReportName({random:true,immediateClaims:true}), 'nft-random-immediate-vault.json');
  assert.throws(() => nftDeploymentReportName({random:false,immediateClaims:true}));
});

const fixture = () => ({ chainId: 46630, probabilitiesBps: [4000,2500,1500,1000,500,300,150,50],
  gradeWeights: [100,150,200,300,400,500,600,800], artworkUris: Array(8).fill('ipfs://test-only-artwork'),
  requestFeeWei: '0', relayerAddress: '0x0000000000000000000000000000000000001234' });
test('requires explicit valid eight-grade policy and excludes other networks', () => {
  assert.equal(randomNftConfig(fixture()).requestFeeWei, 0n);
  for (const update of [ {chainId:4663}, {probabilitiesBps:null}, {probabilitiesBps:[4000,2500,1500,1000,500,300,150,49]},
    {gradeWeights:[100,150,200,300,400,500,600,0]}, {requestFeeWei:'-1'}, {requestFeeWei:'1.5'},
    {artworkUris:Array(8).fill('ipfs://a"injected')}, {relayerAddress:'0x0000000000000000000000000000000000000000'} ]) {
    assert.throws(() => randomNftConfig({...fixture(),...update}));
  }
});
