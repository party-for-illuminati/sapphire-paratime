import { BlockTag, Provider } from '@ethersproject/abstract-provider';
import {
  Signer as Ethers5Signer,
  TypedDataDomain,
  TypedDataField,
  TypedDataSigner,
} from '@ethersproject/abstract-signer';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { BytesLike } from '@ethersproject/bytes';
import * as cbor from 'cborg';
import { ethers } from 'ethers6';
import type {
  CamelCasedProperties,
  Promisable,
  RequireExactlyOne,
} from 'type-fest';

import { Cipher, Envelope } from './cipher.js';

const DEFAULT_GAS_PRICE = 1; // Default gas params are assigned in the web3 gateway.
const DEFAULT_GAS_LIMIT = 30_000_000;
const DEFAULT_VALUE = 0;
const DEFAULT_NONCE_RANGE = 20;
const DEFAULT_BLOCK_RANGE = 4000;
const DEFAULT_DATA = '0x';
const zeroAddress = () => `0x${'0'.repeat(40)}`;

class SignedCallCache {
  // for each signer, we cache the signature of the hash of each SignableCall
  private cachedSignatures = new Map<string, Map<string, Uint8Array>>();
  // for each ChainId, we cache the base block number to make the same leash
  private cachedLeashes = new Map<bigint, Leash>();

  public clear() {
    this.cachedSignatures.clear();
    this.cachedLeashes.clear();
  }

  public cache(
    address: string,
    chainId: bigint,
    call: SignableEthCall,
    hash: string,
    signature: Uint8Array,
  ) {
    if (!this.cachedSignatures.has(address))
      this.cachedSignatures.set(address, new Map<string, Uint8Array>());
    this.cachedSignatures.get(address)!.set(hash, signature);
    this.cachedLeashes.set(chainId, {
      nonce: call.leash.nonce,
      block_number: call.leash.blockNumber,
      block_hash: call.leash.blockHash,
      block_range: call.leash.blockRange,
    });
  }

  public get(address: string, hash: string): Uint8Array | undefined {
    return this.cachedSignatures.get(address)?.get(hash);
  }

  public getLeash(chainId: bigint): Leash | undefined {
    return this.cachedLeashes.get(chainId);
  }
}

const _cache = new SignedCallCache();

/// @deprecated
export type Signer = CallSigner;
export type CallSigner = Ethers5CallSigner | ethers.Signer;

export type Ethers5CallSigner = Pick<
  Ethers5Signer,
  'getTransactionCount' | 'getChainId' | 'getAddress'
> &
  TypedDataSigner & {
    provider?: Pick<Provider, 'getBlock' | 'getNetwork'>;
  };

export function signedCallEIP712Params(chainId: number): {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
} {
  return {
    domain: {
      name: 'oasis-runtime-sdk/evm: signed query',
      version: '1.0.0',
      chainId,
    },
    types: {
      Call: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'gasLimit', type: 'uint64' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'leash', type: 'Leash' },
      ],
      Leash: [
        { name: 'nonce', type: 'uint64' },
        { name: 'blockNumber', type: 'uint64' },
        { name: 'blockHash', type: 'bytes32' },
        { name: 'blockRange', type: 'uint64' },
      ],
    },
  };
}

/**
 * Parameters that define a signed call that shall be
 * CBOR-encoded and sent as the call's `data` field.
 */
export class SignedCallDataPack {
  static async make<C extends EthCall>(
    call: C,
    signer: CallSigner,
    overrides?: PrepareSignedCallOverrides,
  ): Promise<SignedCallDataPack> {
    const leash = await makeLeash(signer, overrides?.leash);
    return new SignedCallDataPack(
      leash,
      await signCall(makeSignableCall(call, leash), signer, {
        chainId: overrides?.chainId,
      }),
      call.data ? parseBytesLike(call.data) : undefined,
    );
  }

  private constructor(
    public readonly leash: Leash,
    /** A signature over the call and leash as generated by `signCall`. */
    public readonly signature: Uint8Array,
    /**
     * An oasis-sdk `Call` without the optional fields.
     *
     * After encryption, `body` would be encrypted and this field would contain a
     * `format` field. The runtime would decode the data as a `types::transaction::Call`.
     **/
    public readonly data?: Uint8Array,
  ) {}

  public encode(): string {
    return this.#encode(this.data ? { body: this.data } : undefined);
  }

  /** Encodes the data pack after encrypting the signed call data. */
  public async encryptEncode(cipher: Cipher): Promise<string> {
    if (this.data) return this.#encode(await cipher.encryptEnvelope(this.data));
    return this.encode();
  }

  #encode(data?: Envelope | { body: Uint8Array }): string {
    return ethers.hexlify(
      cbor.encode({
        data: data ? data : undefined,
        leash: this.leash,
        signature: this.signature,
      }),
    );
  }
}

function parseBytesLike(data: BytesLike): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(data);
  return ethers.getBytesCopy(data as 'string' | Uint8Array);
}

function stringifyBytesLike(data: BytesLike): string {
  if (Array.isArray(data)) return ethers.hexlify(new Uint8Array(data));
  return ethers.hexlify(data as 'string' | Uint8Array);
}

async function makeLeash(
  signer: CallSigner,
  overrides?: LeashOverrides,
): Promise<Leash> {
  // simply invalidate signedCall caches if overrided nonce or block are provided
  if (overrides?.nonce !== undefined || overrides?.block !== undefined) {
    _cache.clear();
  }

  const nonceP = overrides?.nonce
    ? overrides.nonce
    : 'getNonce' in signer
    ? signer.getNonce('pending')
    : signer.getTransactionCount('pending');
  let blockP: Promisable<BlockId>;
  if (overrides?.block !== undefined) {
    blockP = overrides.block;
  } else {
    if (!signer.provider)
      throw new Error(
        '`sapphire.wrap`ped signer was not connected to a provider',
      );
    const latestBlock = await signer.provider.getBlock('latest');
    if (!latestBlock) throw new Error('unable to get latest block');
    blockP = signer.provider!.getBlock(
      latestBlock.number - 2,
    ) as Promise<BlockId>;
  }
  const [nonce, block] = await Promise.all([nonceP, blockP]);
  const blockRange = overrides?.blockRange ?? DEFAULT_BLOCK_RANGE;

  // check whether we should use cached leashes
  if (overrides?.nonce === undefined && overrides?.block === undefined) {
    if (!signer.provider)
      throw new Error(
        '`sapphire.wrap`ped signer was not connected to a provider',
      );
    const { chainId } = await signer.provider.getNetwork();
    const cachedLeash = _cache.getLeash(BigInt(chainId));
    if (cachedLeash !== undefined) {
      // this happens only if neither overried nonce nor block are provided
      // so the pendingNonce and latestBlock are compared with the cachedLeash
      if (
        cachedLeash.nonce > nonce &&
        cachedLeash.block_number + blockRange > block.number + 2
      ) {
        // the cached leash can be still re-usable
        return cachedLeash;
      } else {
        // the cached leash has been outdated
        _cache.clear();
      }
    }
  }

  return {
    nonce: overrides?.nonce ? overrides.nonce : nonce + DEFAULT_NONCE_RANGE,
    block_number: block.number,
    block_hash: ethers.getBytesCopy(block.hash),
    block_range: blockRange,
  };
}

export function makeSignableCall(call: EthCall, leash: Leash): SignableEthCall {
  return {
    from: call.from,
    to: call.to ?? zeroAddress(),
    gasLimit: BigNumber.from(
      call.gas ?? call.gasLimit ?? DEFAULT_GAS_LIMIT,
    ).toNumber(),
    gasPrice: BigNumber.from(call.gasPrice ?? DEFAULT_GAS_PRICE),
    value: BigNumber.from(call.value ?? DEFAULT_VALUE),
    data: call.data ? stringifyBytesLike(call.data) : DEFAULT_DATA,
    leash: {
      nonce: leash.nonce,
      blockNumber: leash.block_number,
      blockHash: leash.block_hash,
      blockRange: leash.block_range,
    },
  };
}

async function signCall(
  call: SignableEthCall,
  signer: CallSigner,
  overrides?: Partial<{ chainId: number | bigint }>,
): Promise<Uint8Array> {
  const address = await signer.getAddress();
  let chainId: number | bigint;
  if (overrides?.chainId) {
    chainId = BigInt(overrides.chainId);
  } else if (signer.provider) {
    ({ chainId } = await signer.provider.getNetwork());
  } else {
    throw new Error(
      'must either connect provider or provide manual chainId override',
    );
  }
  const { domain, types } = signedCallEIP712Params(Number(chainId));
  const upgradedDomain = upgradeDomain(domain);
  const upgradedCall = upgradeCall(call);
  const hash = ethers.TypedDataEncoder.hash(
    upgradedDomain,
    types,
    upgradedCall,
  );
  let signature = _cache.get(address, hash);
  // if (signature !== undefined) return signature;
  if ('_signTypedData' in signer) {
    signature = ethers.getBytes(
      await signer._signTypedData(domain, types, call),
    );
  } else {
    signature = ethers.getBytes(
      await signer.signTypedData(upgradedDomain, types, upgradedCall),
    );
  }
  _cache.cache(address, BigInt(chainId), call, hash, signature);
  return signature;
}

function upgradeDomain(domain: TypedDataDomain): ethers.TypedDataDomain {
  return {
    ...domain,
    salt: domain.salt ? parseBytesLike(domain.salt) : undefined,
    chainId: domain.chainId
      ? BigNumber.from(domain.chainId).toHexString()
      : undefined,
  };
}

function upgradeCall(call: SignableEthCall) {
  const big2int = (
    b?: BigNumber | bigint | number | string,
  ): string | undefined => {
    if (b === undefined || b === null) return undefined;
    if (typeof b === 'string') return b;
    if (b instanceof BigNumber) return b.toHexString();
    return ethers.toQuantity(b);
  };
  return {
    ...call,
    gasPrice: big2int(call.gasPrice),
    value: big2int(call.value),
    data: call.data ? ethers.getBytes(call.data) : undefined,
  };
}

export type PrepareSignedCallOverrides = Partial<{
  leash: LeashOverrides;
  chainId: number;
}>;

export type LeashOverrides = Partial<
  {
    nonce: number;
    blockRange: number;
  } & RequireExactlyOne<{
    block: BlockId;
    blockTag: BlockTag;
  }>
>;

export type EthCall = {
  /** 0x-prefixed hex-encoded address. */
  from: string;
  /** Optional 0x-prefixed hex-encoded address. */
  to?: string;
  value?: BigNumberish;
  gasPrice?: BigNumberish;
  data?: BytesLike;
} & Partial<
  RequireExactlyOne<{
    gas: number | string; // web3.js
    gasLimit: BigNumberish; // ethers
  }>
>;

/**
 * The structure passed to eth_signTypedData_v4.
 *
 * `uint256`, `address`, and `bytes` are required to be hex-stringified.
 */
export type SignableEthCall = {
  from: string;
  to: string;
  gasLimit?: number;
  gasPrice?: BigNumber;
  value?: BigNumber;
  data?: string;
  leash: CamelCasedProperties<Leash>;
};

export type Leash = {
  /** The largest sender account nonce whence the call will be valid. */
  nonce: number;
  /** The block number whence the call will be valid. */
  block_number: number; // uint64
  /** The expected block hash to be found at `block_number`. */
  block_hash: Uint8Array;
  /** The number of blocks past the block at `block_number` whence the call will be valid. */
  block_range: number; // uint64
};

export type BlockId = { hash: string; number: number };
