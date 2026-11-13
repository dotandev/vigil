// Wallet actions. Watching needs no wallet; acting does.

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import "@near-wallet-selector/modal-ui/styles.css";

const TGAS = 1_000_000_000_000n;
const YOCTO_PER_NEAR = 10n ** 24n;

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;
let currentContract = "";

export async function initWallet(contract: string, onChange: (account: string | null) => void) {
  if (selector && contract === currentContract) return;
  currentContract = contract;
  selector = await setupWalletSelector({
    network: "testnet",
    modules: [setupMyNearWallet(), setupMeteorWallet()],
  });
  modal = setupModal(selector, { contractId: contract, theme: "dark" });
  const emit = () => {
    const acc = selector!.store.getState().accounts.find((a) => a.active);
    onChange(acc?.accountId ?? null);
  };
  selector.store.observable.subscribe(emit);
  emit();
}

export function showConnect() {
  modal?.show();
}

export async function signOut() {
  if (!selector) return;
  const wallet = await selector.wallet();
  await wallet.signOut();
}

export function nearToYocto(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{0,24})?$/.test(trimmed)) throw new Error("enter an amount like 1 or 0.5");
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

async function call(method: string, args: object, deposit = 0n, gasTgas = 50n) {
  if (!selector) throw new Error("wallet not ready");
  if (!selector.isSignedIn()) {
    showConnect();
    throw new Error("connect a wallet first");
  }
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: currentContract,
    actions: [actionCreators.functionCall(method, args, gasTgas * TGAS, deposit)],
  });
}

export const checkIn = () => call("check_in", {});
export const feed = (owner: string, yocto: bigint) => call("feed", { owner }, yocto);
export const tick = (owner: string) => call("tick", { owner });
