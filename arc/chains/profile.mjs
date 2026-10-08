// Chain profiles: every number and address a SingleSpark deployment takes from the chain it runs on.
// `backend/chains/<chainId>.json` is committed per chain; nothing is guessed for a chain without one.
// Amounts are in the chain's native currency (18 decimals) and come back as BigInt.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress } from 'viem';

const directory = fileURLToPath(new URL('.', import.meta.url));
// The strategy's own bounds (TICK_SPACING, the upper end of the opening-tick search, v4's MIN_TICK).
const TICK_SPACING = 25;
const MAX_OPENING_TICK = 251_325;
const MIN_TICK = -887_272;
const UINT256_MAX = (1n << 256n) - 1n;

const fail = (source, message) => { throw new Error(`Chain profile ${source}: ${message}`); };
const exactKeys = (source, where, value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(source, `${where} must be an object`);
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!known.has(key)) fail(source, `unknown key ${where}.${key}`);
  for (const key of required) if (!(key in value)) fail(source, `missing ${where}.${key}`);
};

/**
 * A native amount: a decimal integer string ("10000000000000000000000") or exact scientific notation
 * ("2e18", "0.25e18"). Numbers are refused, because JSON numbers lose precision above 2^53.
 */
export function parseAmount(value, label = 'amount') {
  if (typeof value !== 'string') throw new Error(`${label} must be a string, not ${typeof value}`);
  let match;
  if ((match = /^(0|[1-9]\d*)$/.exec(value))) return check(BigInt(match[1]));
  if (!(match = /^(0|[1-9]\d*)(?:\.(\d+))?e(\d{1,3})$/.exec(value))) throw new Error(`${label} ${JSON.stringify(value)} is not an integer or exact <digits>e<exponent>`);
  const [, whole, fraction = '', exponent] = match;
  const shift = Number(exponent) - fraction.length;
  if (shift < 0) throw new Error(`${label} ${value} is not a whole number of wei`);
  return check(BigInt(whole + fraction) * 10n ** BigInt(shift));
  function check(result) {
    if (result > UINT256_MAX) throw new Error(`${label} ${value} exceeds uint256`);
    return result;
  }
}

const optionalAddress = (source, where, value) => {
  if (value === null) return null;
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) fail(source, `${where} must be a non-zero address or null`);
  return getAddress(value);
};

/** Validates a parsed profile object strictly and returns it with BigInt amounts and checksummed addresses. */
export function parseProfile(json, source = 'profile') {
  exactKeys(source, 'profile', json, ['chainId', 'name', 'testnet', 'nativeCurrency', 'uniswapV4', 'economics']);
  const { chainId, name, testnet, nativeCurrency, uniswapV4, economics } = json;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail(source, 'chainId must be a positive integer');
  if (typeof name !== 'string' || !name.trim()) fail(source, 'name must be a non-empty string');
  if (typeof testnet !== 'boolean') fail(source, 'testnet must be true or false');

  exactKeys(source, 'nativeCurrency', nativeCurrency, ['name', 'symbol', 'decimals']);
  if (typeof nativeCurrency.name !== 'string' || !nativeCurrency.name) fail(source, 'nativeCurrency.name must be a non-empty string');
  if (typeof nativeCurrency.symbol !== 'string' || !/^[A-Za-z0-9.]{1,12}$/.test(nativeCurrency.symbol)) fail(source, 'nativeCurrency.symbol must be 1-12 letters or digits');
  // Every amount in the contracts, the backend and the frontend is 18-decimal native wei.
  if (nativeCurrency.decimals !== 18) fail(source, 'nativeCurrency.decimals must be 18');

  const v4Keys = ['poolManager', 'positionManager', 'quoter', 'stateView', 'permit2'];
  exactKeys(source, 'uniswapV4', uniswapV4, v4Keys);
  const v4 = Object.fromEntries(v4Keys.map(key => [key, optionalAddress(source, `uniswapV4.${key}`, uniswapV4[key])]));

  exactKeys(source, 'economics', economics, ['halfSupplyCost', 'minLaunchTick', 'minBuyback', 'keeperGas']);
  const amount = (value, where) => { try { return parseAmount(value, `economics.${where}`); } catch (error) { return fail(source, error.message); } };
  const halfSupplyCost = amount(economics.halfSupplyCost, 'halfSupplyCost');
  const minBuyback = amount(economics.minBuyback, 'minBuyback');
  const { minLaunchTick } = economics;
  if (halfSupplyCost === 0n) fail(source, 'economics.halfSupplyCost must be positive');
  if (minBuyback === 0n) fail(source, 'economics.minBuyback must be positive');
  // The same bounds ArcLaunchStrategy's constructor enforces; the solvability of the curve itself is
  // checked by the constructor on chain (and simulated by deploy.mjs before anything is broadcast).
  if (!Number.isSafeInteger(minLaunchTick) || minLaunchTick % TICK_SPACING !== 0 || minLaunchTick <= MIN_TICK
    || minLaunchTick >= MAX_OPENING_TICK - 2 * TICK_SPACING) {
    fail(source, `economics.minLaunchTick must be a multiple of ${TICK_SPACING} in (${MIN_TICK}, ${MAX_OPENING_TICK - 2 * TICK_SPACING})`);
  }

  const gasKeys = ['trigger', 'buffer', 'maxTopup', 'minTopup', 'dailyLimit'];
  exactKeys(source, 'economics.keeperGas', economics.keeperGas, gasKeys);
  const keeperGas = Object.fromEntries(gasKeys.map(key => [key, amount(economics.keeperGas[key], `keeperGas.${key}`)]));
  // ArcLaunchV2's constructor invariants, so a bad profile fails here instead of on chain.
  if (keeperGas.minTopup === 0n) fail(source, 'keeperGas.minTopup must be positive');
  if (keeperGas.minTopup > keeperGas.maxTopup) fail(source, 'keeperGas.minTopup must not exceed maxTopup');
  if (keeperGas.maxTopup > keeperGas.trigger) fail(source, 'keeperGas.maxTopup must not exceed trigger');
  if (keeperGas.maxTopup > keeperGas.dailyLimit) fail(source, 'keeperGas.maxTopup must not exceed dailyLimit');
  if (keeperGas.buffer < keeperGas.maxTopup) fail(source, 'keeperGas.buffer must cover at least one maxTopup');

  return Object.freeze({
    chainId, name, testnet,
    nativeCurrency: Object.freeze({ ...nativeCurrency }),
    uniswapV4: Object.freeze(v4),
    economics: Object.freeze({ halfSupplyCost, minLaunchTick, minBuyback, keeperGas: Object.freeze(keeperGas) }),
  });
}

export function loadProfileFile(path) {
  let json;
  try { json = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Chain profile ${path}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`); }
  return parseProfile(json, path);
}

export const profilePath = chainId => resolve(directory, `${Number(chainId)}.json`);
export const hasChainProfile = chainId => Number.isSafeInteger(Number(chainId)) && existsSync(profilePath(chainId));

/** The committed profile for a chain. Refuses a chain without one and a profile without its v4 core. */
export function loadChainProfile(chainId) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid chain id ${chainId}`);
  const path = profilePath(id);
  if (!existsSync(path)) throw new Error(`No committed chain profile for chain ${id} (expected backend/chains/${id}.json)`);
  const profile = loadProfileFile(path);
  if (profile.chainId !== id) throw new Error(`Chain profile ${path} declares chain ${profile.chainId}`);
  if (!profile.uniswapV4.poolManager || !profile.uniswapV4.positionManager) {
    throw new Error(`Chain profile ${path}: a committed profile needs uniswapV4.poolManager and uniswapV4.positionManager`);
  }
  return profile;
}

/**
 * For read-only verifiers: the committed profile of `chainId`, or the profile file named by
 * ARC_CHAIN_PROFILE (a local or synthetic chain), which must then declare the same chain.
 */
export function resolveProfile(chainId, path = process.env.ARC_CHAIN_PROFILE) {
  if (!path) return loadChainProfile(chainId);
  const profile = loadProfileFile(path);
  if (profile.chainId !== Number(chainId)) throw new Error(`Chain profile ${path} declares chain ${profile.chainId}, not ${chainId}`);
  return profile;
}

/** The `KeeperGas` struct argument of ArcLaunchV2's constructor. */
export const keeperGasArgument = profile => ({ ...profile.economics.keeperGas });

/** JSON-safe summary for deployment records and journals. */
export const profileSummary = profile => ({
  chainId: profile.chainId, name: profile.name, testnet: profile.testnet, nativeSymbol: profile.nativeCurrency.symbol,
  halfSupplyCost: String(profile.economics.halfSupplyCost), minLaunchTick: profile.economics.minLaunchTick,
  minBuyback: String(profile.economics.minBuyback),
  keeperGas: Object.fromEntries(Object.entries(profile.economics.keeperGas).map(([key, value]) => [key, String(value)])),
});
