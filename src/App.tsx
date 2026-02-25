import "./App.css";
import { useState, useCallback, useEffect, useRef } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import {
  useWallets,
  useSignAndSendTransaction,
  toSolanaWalletConnectors,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import {
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const PRIVY_APP_ID: string =
  (import.meta as any).env?.VITE_PRIVY_APP_ID ?? "cmm1gbs2300qj0cjiz3ewb3ys";

const RPC_URL =
  "https://solana-mainnet.g.alchemy.com/v2/nRR5_ECTUtjWlB8iSu59C";

const getConnection = () =>
  new Connection(RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });

const connection = getConnection();
const explorerUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}`;

// ─────────────────────────────────────────────────────────────────────────────
// BATCH SIZE CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const BATCH_SIZE_SOL = 18;
const BATCH_SIZE_ATA = 5;
const BATCH_SIZE_SPL_TRANSFER = 14;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
type TransferMode = "single" | "bulk";
type TokenType = "SOL" | "SPL";
type BulkPhase =
  | "idle"
  | "preflight"
  | "ata"
  | "confirming_ata"
  | "transfer"
  | "confirming_transfer"
  | "done";

interface WalletToken {
  mint: string;
  balance: number;
  decimals: number;
  symbol: string;
  /** Which on-chain program owns this mint — Token or Token-2022 */
  tokenProgramId: PublicKey;
}

interface BulkRecipient {
  id: string;
  address: string;
  amount: string;
  status: "idle" | "pending" | "success" | "error";
  txHash?: string;
  error?: string;
}

interface TxStatus {
  type: "idle" | "loading" | "success" | "error";
  message?: string;
  txHash?: string;
}

interface SubmittedTx {
  sig: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const emptyRow = (): BulkRecipient => ({
  id: uid(),
  address: "",
  amount: "",
  status: "idle",
});

const chunk = <T,>(arr: T[], size: number): T[][] =>
  arr.length === 0
    ? []
    : Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size)
      );

function parsePaste(text: string, defaultAmount: string): BulkRecipient[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => {
      const parts = line.split(/[,\t]|\s{2,}/).map((s) => s.trim());
      const address = parts[0] ?? "";
      const amount = parts[1] ?? defaultAmount;
      return { id: uid(), address, amount, status: "idle" as const };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the token program ID for a given mint address.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveTokenProgramId(
  conn: Connection,
  mintAddress: string
): Promise<PublicKey> {
  try {
    const info = await conn.getAccountInfo(new PublicKey(mintAddress));
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
  } catch (_) {}
  return TOKEN_PROGRAM_ID;
}

// ─────────────────────────────────────────────────────────────────────────────
// INNER APP
// ─────────────────────────────────────────────────────────────────────────────
function InnerApp() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const wallet: any = wallets[0];
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const [mode, setMode] = useState<TransferMode>("single");
  const [tokenType, setTokenType] = useState<TokenType>("SOL");
  const [mintAddr, setMintAddr] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [txStatus, setTxStatus] = useState<TxStatus>({ type: "idle" });
  const [balance, setBalance] = useState<number | null>(null);
  const [walletTokens, setWalletTokens] = useState<WalletToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [rows, setRows] = useState<BulkRecipient[]>([
    emptyRow(),
    emptyRow(),
    emptyRow(),
  ]);
  const [progress, setProgress] = useState(0);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkPhase, setBulkPhase] = useState<BulkPhase>("idle");
  const [phaseMsg, setPhaseMsg] = useState("");
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteDefaultAmount, setPasteDefaultAmount] = useState("");
  const MAX_AUTO_RETRIES = 5;
  const autoRetryCountRef = useRef(0);   // ref so catch blocks read/write it synchronously
  const bulkChannelRef = useRef<BroadcastChannel | null>(null);
  const handleBulkRef = useRef<(() => void) | null>(null);
  const isAutoRetryRef = useRef(false);

  // ── Balance polling ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!wallet?.address) return;
    const poll = async () => {
      try {
        const b = await connection.getBalance(new PublicKey(wallet.address));
        setBalance(b / LAMPORTS_PER_SOL);
      } catch (_) {}
    };
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [wallet?.address]);

  // ── BroadcastChannel: sync retry signals across all open tabs ───────────
  useEffect(() => {
    const ch = new BroadcastChannel("solsend_bulk_retry");
    bulkChannelRef.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type === "RETRY_BULK") {
        // Another tab errored and is retrying — mirror immediately
        autoRetryCountRef.current += 1;
        isAutoRetryRef.current = true;
        handleBulkRef.current?.();
      }
    };
    return () => {
      ch.close();
      bulkChannelRef.current = null;
    };
  }, []);

  // ── Auto-detect SPL tokens (TOKEN_PROGRAM_ID + TOKEN_2022_PROGRAM_ID) ────
  useEffect(() => {
    if (!wallet?.address) return;
    const fetchTokens = async () => {
      setTokensLoading(true);
      try {
        const owner = new PublicKey(wallet.address);

        const [legacyResult, t22Result] = await Promise.allSettled([
          connection.getParsedTokenAccountsByOwner(owner, {
            programId: TOKEN_PROGRAM_ID,
          }),
          connection.getParsedTokenAccountsByOwner(owner, {
            programId: TOKEN_2022_PROGRAM_ID,
          }),
        ]);

        const legacyAccounts =
          legacyResult.status === "fulfilled"
            ? legacyResult.value.value
            : [];
        const t22Accounts =
          t22Result.status === "fulfilled"
            ? t22Result.value.value
            : [];

        if (t22Result.status === "rejected") {
          console.warn(
            "Token-2022 account fetch failed (non-fatal):",
            (t22Result as PromiseRejectedResult).reason
          );
        }

        const mapAccounts = (
          accounts: typeof legacyAccounts,
          programId: PublicKey
        ): WalletToken[] =>
          accounts
            .map((acct) => {
              const info = acct.account.data.parsed.info;
              const uiAmount: number = info.tokenAmount.uiAmount ?? 0;
              return {
                mint: info.mint as string,
                balance: uiAmount,
                decimals: info.tokenAmount.decimals as number,
                symbol: `${(info.mint as string).slice(0, 4)}…${(
                  info.mint as string
                ).slice(-4)}`,
                tokenProgramId: programId,
              };
            })
            .filter((t) => {
              if (t.balance > 0) return true;
              const rawAmt = accounts.find(
                (a) => a.account.data.parsed.info.mint === t.mint
              )?.account.data.parsed.info.tokenAmount.amount;
              return rawAmt && rawAmt !== "0";
            });

        const combined = [
          ...mapAccounts(legacyAccounts, TOKEN_PROGRAM_ID),
          ...mapAccounts(t22Accounts, TOKEN_2022_PROGRAM_ID),
        ];

        const seen = new Set<string>();
        const tokens = combined.filter((t) => {
          if (seen.has(t.mint)) return false;
          seen.add(t.mint);
          return true;
        });

        setWalletTokens(tokens);

        // ── FIX: use functional updater to read the CURRENT mintAddr value,
        // not the stale closure copy. Without this, the 30-second poll always
        // sees mintAddr="" (initial value) and resets the selection every time.
        setMintAddr((prev) => {
          // Only auto-select the first token if nothing has been chosen yet.
          if (!prev && tokens.length > 0) return tokens[0].mint;
          // Always preserve whatever the user has already selected.
          return prev;
        });
      } catch (e) {
        console.warn("Could not fetch wallet tokens:", e);
      } finally {
        setTokensLoading(false);
      }
    };
    fetchTokens();
    const t = setInterval(fetchTokens, 30_000);
    return () => clearInterval(t);
  }, [wallet?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────
  // GET FINALIZED BLOCKHASH
  // ─────────────────────────────────────────────────────────────────────────
  const getFinalizedBlockhash = useCallback(async (): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> => {
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await getConnection().getLatestBlockhash("finalized");
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1_200 * (attempt + 1)));
      }
    }
    throw new Error(
      `RPC error getting blockhash: ${lastErr?.message ?? lastErr}`
    );
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // LOW-LEVEL: submit ONE tx via Privy with rate-limit handling
  // ─────────────────────────────────────────────────────────────────────────
  const sendTxSubmitOnly = useCallback(
    async (
      instructions: any[],
      showUI: boolean = true
    ): Promise<SubmittedTx> => {
      if (!wallet) throw new Error("No wallet connected");

      const RATE_LIMIT_WINDOW_MS = 65_000;
      const MAX_ATTEMPTS = 3;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { blockhash, lastValidBlockHeight } =
          await getFinalizedBlockhash();

        const from = new PublicKey(wallet.address);
        const msg = new TransactionMessage({
          payerKey: from,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        const serialized = tx.serialize() as unknown as Uint8Array;

        try {
          const { signature } = await signAndSendTransaction({
            transaction: serialized,
            wallet,
            options: {
              sponsor: true,
              skipPreflight: true,
              uiOptions: { showWalletUIs: showUI },
            } as any,
          });
          return { sig: signature as string, blockhash, lastValidBlockHeight };
        } catch (e: any) {
          const errMsg: string =
            e?.message ??
            e?.error?.message ??
            e?.cause?.message ??
            JSON.stringify(e);

          const isRateLimit =
            errMsg.includes("429") ||
            errMsg.toLowerCase().includes("too many requests") ||
            errMsg.toLowerCase().includes("rate limit");

          if (isRateLimit && attempt < MAX_ATTEMPTS) {
            console.warn(
              `[SolSend] 429 — waiting ${RATE_LIMIT_WINDOW_MS / 1000}s for rate limit window to reset (attempt ${attempt}/${MAX_ATTEMPTS})`
            );
            await new Promise((r) => setTimeout(r, RATE_LIMIT_WINDOW_MS));
            continue;
          }

          throw new Error(errMsg);
        }
      }

      throw new Error("Rate limit retries exhausted");
    },
    [wallet, signAndSendTransaction, getFinalizedBlockhash]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // LOW-LEVEL: submit + confirm (single transfers — shows UI)
  // ─────────────────────────────────────────────────────────────────────────
  const sendTx = useCallback(
    async (instructions: any[]): Promise<string> => {
      const submitted = await sendTxSubmitOnly(instructions, true);
      try {
        await getConnection().confirmTransaction(
          {
            signature: submitted.sig,
            blockhash: submitted.blockhash,
            lastValidBlockHeight: submitted.lastValidBlockHeight,
          },
          "confirmed"
        );
      } catch (_) {}
      return submitted.sig;
    },
    [sendTxSubmitOnly]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // BATCH SENDER
  // ─────────────────────────────────────────────────────────────────────────
  const sendAllTxs = useCallback(
    async (
      ixBatches: any[][],
      onBatchDone?: (batchIdx: number, sig: string) => void,
      onConfirmProgress?: (confirmed: number, total: number) => void
    ): Promise<string[]> => {
      if (!wallet) throw new Error("No wallet connected");
      const isEmbedded = wallet.walletClientType === "privy";

      if (!isEmbedded && typeof wallet.signAllTransactions === "function") {
        const { blockhash, lastValidBlockHeight } =
          await getFinalizedBlockhash();
        const from = new PublicKey(wallet.address);

        const txs = ixBatches.map((ixs) => {
          const msg = new TransactionMessage({
            payerKey: from,
            recentBlockhash: blockhash,
            instructions: ixs,
          }).compileToV0Message();
          return new VersionedTransaction(msg);
        });

        const signedTxs: VersionedTransaction[] =
          await wallet.signAllTransactions(txs);

        const conn = getConnection();
        const rawSigs = await Promise.all(
          signedTxs.map((tx) =>
            conn.sendRawTransaction(tx.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            })
          )
        );
        const sigs: string[] = [];
        for (let i = 0; i < rawSigs.length; i++) {
          const sig = rawSigs[i];
          try {
            await conn.confirmTransaction(
              { signature: sig, blockhash, lastValidBlockHeight },
              "confirmed"
            );
          } catch (_) {}
          sigs.push(sig);
          onBatchDone?.(i, sig);
          onConfirmProgress?.(i + 1, rawSigs.length);
        }
        return sigs;
      } else {
        const INTER_TX_DELAY_MS = 2_000;

        const submitted: SubmittedTx[] = [];
        for (let i = 0; i < ixBatches.length; i++) {
          const result = await sendTxSubmitOnly(ixBatches[i], false);
          submitted.push(result);
          if (i < ixBatches.length - 1) {
            await new Promise((r) => setTimeout(r, INTER_TX_DELAY_MS));
          }
        }
        const conn = getConnection();
        const sigs: string[] = [];
        for (let i = 0; i < submitted.length; i++) {
          const { sig, blockhash, lastValidBlockHeight } = submitted[i];
          try {
            await conn.confirmTransaction(
              { signature: sig, blockhash, lastValidBlockHeight },
              "confirmed"
            );
          } catch (_) {}
          sigs.push(sig);
          onBatchDone?.(i, sig);
          onConfirmProgress?.(i + 1, submitted.length);
        }
        return sigs;
      }
    },
    [wallet, sendTxSubmitOnly, getFinalizedBlockhash]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // SOL helpers
  // ─────────────────────────────────────────────────────────────────────────
  const sendSOL = useCallback(
    async (to: string, lamports: number): Promise<string> => {
      if (!wallet) throw new Error("No wallet connected");
      return sendTx([
        SystemProgram.transfer({
          fromPubkey: new PublicKey(wallet.address),
          toPubkey: new PublicKey(to),
          lamports,
        }),
      ]);
    },
    [wallet, sendTx]
  );

  const buildSOLBatchIxs = useCallback(
    (batch: BulkRecipient[]) => {
      if (!wallet) throw new Error("No wallet connected");
      return batch.map((r) =>
        SystemProgram.transfer({
          fromPubkey: new PublicKey(wallet.address),
          toPubkey: new PublicKey(r.address),
          lamports: Math.round(parseFloat(r.amount) * LAMPORTS_PER_SOL),
        })
      );
    },
    [wallet]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // SPL single transfer — supports both Token and Token-2022
  // ─────────────────────────────────────────────────────────────────────────
  const sendSPL = useCallback(
    async (to: string, mint: string, raw: number): Promise<string> => {
      if (!wallet) throw new Error("No wallet connected");
      let mintPk: PublicKey, toPk: PublicKey;
      try {
        mintPk = new PublicKey(mint);
        toPk = new PublicKey(to);
      } catch {
        throw new Error("Invalid mint or recipient address");
      }
      const from = new PublicKey(wallet.address);

      const cached = walletTokens.find((t) => t.mint === mint);
      const tokenProgram: PublicKey =
        cached?.tokenProgramId ??
        (await resolveTokenProgramId(connection, mint));

      let decimals: number;
      try {
        const mintInfo = await getMint(connection, mintPk, "confirmed", tokenProgram);
        decimals = mintInfo.decimals;
      } catch (e: any) {
        if (cached) decimals = cached.decimals;
        else
          throw new Error(
            `Cannot fetch token mint. Mint: ${mint.slice(0, 8)}… Error: ${
              e?.message ?? e
            }`
          );
      }

      const amt = BigInt(Math.round(raw * 10 ** decimals));
      const fromATA = await getAssociatedTokenAddress(
        mintPk,
        from,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const toATA = await getAssociatedTokenAddress(
        mintPk,
        toPk,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const fromInfo = await connection.getAccountInfo(fromATA);
      if (!fromInfo)
        throw new Error(
          "You don't hold this token (no Associated Token Account found)"
        );

      const ixs: any[] = [];
      if (!(await connection.getAccountInfo(toATA))) {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            from,
            toATA,
            toPk,
            mintPk,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      ixs.push(
        createTransferInstruction(fromATA, toATA, from, amt, [], tokenProgram)
      );
      return sendTx(ixs);
    },
    [wallet, sendTx, walletTokens]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TWO-PHASE PREFLIGHT — supports both Token and Token-2022
  // ─────────────────────────────────────────────────────────────────────────
  const buildTwoPhaseIxBatches = useCallback(
    async (validRows: BulkRecipient[], mint: string) => {
      if (!wallet) throw new Error("No wallet connected");
      const mintPk = new PublicKey(mint);
      const from = new PublicKey(wallet.address);

      const cached = walletTokens.find((t) => t.mint === mint);
      const tokenProgram: PublicKey =
        cached?.tokenProgramId ??
        (await resolveTokenProgramId(connection, mint));

      let decimals: number;
      try {
        const mintInfo = await getMint(connection, mintPk, "confirmed", tokenProgram);
        decimals = mintInfo.decimals;
      } catch (e: any) {
        if (cached) decimals = cached.decimals;
        else
          throw new Error(
            `Cannot fetch mint: ${mint.slice(0, 8)}… ${e?.message ?? e}`
          );
      }

      const fromATA = await getAssociatedTokenAddress(
        mintPk,
        from,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const fromInfo = await connection.getAccountInfo(fromATA);
      if (!fromInfo)
        throw new Error("You don't hold this token (no ATA found for sender)");

      const toPks = validRows.map((r) => new PublicKey(r.address));
      const toATAs = await Promise.all(
        toPks.map((pk) =>
          getAssociatedTokenAddress(
            mintPk,
            pk,
            false,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        )
      );
      const toATAInfos = await Promise.all(
        toATAs.map((ata) => connection.getAccountInfo(ata))
      );

      const ataIxs: any[] = [];
      toATAInfos.forEach((info, i) => {
        if (!info) {
          ataIxs.push(
            createAssociatedTokenAccountInstruction(
              from,
              toATAs[i],
              toPks[i],
              mintPk,
              tokenProgram,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }
      });

      const transferIxs: any[] = validRows.map((r, i) => {
        const amt = BigInt(Math.round(parseFloat(r.amount) * 10 ** decimals));
        return createTransferInstruction(
          fromATA,
          toATAs[i],
          from,
          amt,
          [],
          tokenProgram
        );
      });

      return {
        ataIxBatches: chunk(ataIxs, BATCH_SIZE_ATA),
        transferIxBatches: chunk(transferIxs, BATCH_SIZE_SPL_TRANSFER),
        missingAtaCount: ataIxs.length,
        decimals,
      };
    },
    [wallet, walletTokens]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLE TRANSFER
  // ─────────────────────────────────────────────────────────────────────────
  const handleSingle = async () => {
    setTxStatus({ type: "loading", message: "Awaiting signature…" });
    try {
      const sig =
        tokenType === "SOL"
          ? await sendSOL(
              recipient,
              Math.round(parseFloat(amount) * LAMPORTS_PER_SOL)
            )
          : await sendSPL(recipient, mintAddr, parseFloat(amount));
      setTxStatus({
        type: "success",
        message: "Transfer confirmed! ⚡",
        txHash: sig,
      });
    } catch (e: unknown) {
      setTxStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed",
      });
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // BULK TRANSFER
  // ─────────────────────────────────────────────────────────────────────────
  const handleBulk = useCallback(async () => {
    setBulkRunning(true);
    setProgress(0);
    // Only reset the retry counter when the user manually clicks Send
    if (!isAutoRetryRef.current) autoRetryCountRef.current = 0;
    isAutoRetryRef.current = false;
    setBulkPhase("preflight");
    setPhaseMsg("Scanning recipient accounts…");
    const valid = rows.filter((r) => r.address && r.amount);
    const allIds = new Set(valid.map((r) => r.id));
    setRows((p) =>
      p.map((x) => (allIds.has(x.id) ? { ...x, status: "pending" } : x))
    );

    if (tokenType === "SOL") {
      const batches = chunk(valid, BATCH_SIZE_SOL);
      setBulkPhase("transfer");
      const estSecs = Math.ceil(batches.length * 2);
      setPhaseMsg(
        `Sending SOL to ${valid.length} wallets (${batches.length} tx${
          batches.length !== 1 ? "s" : ""
        }, ~${estSecs}s)…`
      );
      try {
        await sendAllTxs(
          batches.map((batch) => buildSOLBatchIxs(batch)),
          (batchIdx, sig) => {
            const batchIds = new Set(batches[batchIdx].map((r) => r.id));
            setRows((p) =>
              p.map((x) =>
                batchIds.has(x.id)
                  ? { ...x, status: "success", txHash: sig }
                  : x
              )
            );
            setProgress(
              Math.round(((batchIdx + 1) / batches.length) * 100)
            );
          },
          (confirmed, total) => {
            setPhaseMsg(`Confirming ${confirmed}/${total} transactions…`);
          }
        );
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : "Failed";
        setRows((p) =>
          p.map((x) =>
            allIds.has(x.id) && x.status === "pending"
              ? { ...x, status: "error", error: errMsg }
              : x
          )
        );
        setBulkPhase("idle");
        setBulkRunning(false);

        // ── Auto-retry immediately across all tabs ──────────────────────
        if (autoRetryCountRef.current < MAX_AUTO_RETRIES) {
          autoRetryCountRef.current += 1;
          const attempt = autoRetryCountRef.current;
          setPhaseMsg(`⚠️ Error — retrying now… (attempt ${attempt}/${MAX_AUTO_RETRIES})`);
          setRows((p) => p.map((x) => x.status === "error" ? { ...x, status: "idle", error: undefined } : x));
          bulkChannelRef.current?.postMessage({ type: "RETRY_BULK" });
          isAutoRetryRef.current = true;
          handleBulkRef.current?.();
        } else {
          setPhaseMsg(`❌ Failed after ${MAX_AUTO_RETRIES} attempts. Please retry manually.`);
        }
        return;
      }
      setBulkPhase("done");
      setPhaseMsg("All done! ⚡");
      setBulkRunning(false);
      return;
    }

    try {
      const { ataIxBatches, transferIxBatches, missingAtaCount } =
        await buildTwoPhaseIxBatches(valid, mintAddr);

      const totalBatches = ataIxBatches.length + transferIxBatches.length;
      let batchesDone = 0;

      if (ataIxBatches.length > 0) {
        setBulkPhase("ata");
        setPhaseMsg(
          `Phase 1/2 — Creating ${missingAtaCount} ATAs in ${
            ataIxBatches.length
          } tx${ataIxBatches.length !== 1 ? "s" : ""}…`
        );
        await sendAllTxs(
          ataIxBatches,
          (_i) => {
            batchesDone++;
            setProgress(Math.round((batchesDone / totalBatches) * 50));
          },
          (confirmed, total) => {
            setBulkPhase("confirming_ata");
            setPhaseMsg(`Confirming ATAs ${confirmed}/${total}…`);
          }
        );
        setPhaseMsg(
          `✅ All ${missingAtaCount} ATAs confirmed. Starting transfers…`
        );
        await new Promise((res) => setTimeout(res, 800));
      }

      setBulkPhase("transfer");
      const estSecs = Math.ceil(transferIxBatches.length * 2);
      setPhaseMsg(
        `Phase 2/2 — Transferring to ${valid.length} wallets in ${
          transferIxBatches.length
        } tx${transferIxBatches.length !== 1 ? "s" : ""} (~${estSecs}s)…`
      );

      let rowCursor = 0;
      const transferRowIdBatches = transferIxBatches.map((batch) => {
        const ids = valid
          .slice(rowCursor, rowCursor + batch.length)
          .map((r) => r.id);
        rowCursor += batch.length;
        return new Set(ids);
      });

      let transferBatchIdx = 0;
      await sendAllTxs(
        transferIxBatches,
        (batchIdx, sig) => {
          const idSet = transferRowIdBatches[batchIdx];
          setRows((p) =>
            p.map((x) =>
              idSet.has(x.id) ? { ...x, status: "success", txHash: sig } : x
            )
          );
          batchesDone++;
          setProgress(
            50 +
              Math.round(
                ((transferBatchIdx + 1) / transferIxBatches.length) * 50
              )
          );
          transferBatchIdx++;
        },
        (confirmed, total) => {
          setBulkPhase("confirming_transfer");
          setPhaseMsg(`Confirming transfers ${confirmed}/${total}…`);
        }
      );

      setBulkPhase("done");
      setPhaseMsg("All done! ⚡");
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : "Bulk transfer failed";
      setRows((p) =>
        p.map((x) =>
          allIds.has(x.id) && x.status === "pending"
            ? { ...x, status: "error", error: errMsg }
            : x
        )
      );
      setBulkPhase("idle");
      setBulkRunning(false);

      // ── Auto-retry immediately across all tabs ──────────────────────
      if (autoRetryCountRef.current < MAX_AUTO_RETRIES) {
        autoRetryCountRef.current += 1;
        const attempt = autoRetryCountRef.current;
        setPhaseMsg(`⚠️ Error — retrying now… (attempt ${attempt}/${MAX_AUTO_RETRIES})`);
        setRows((p) => p.map((x) => x.status === "error" ? { ...x, status: "idle", error: undefined } : x));
        bulkChannelRef.current?.postMessage({ type: "RETRY_BULK" });
        isAutoRetryRef.current = true;
        handleBulkRef.current?.();
      } else {
        setPhaseMsg(`❌ Failed after ${MAX_AUTO_RETRIES} attempts. Please retry manually.`);
      }
    }
    setBulkRunning(false);
  }, [rows, tokenType, mintAddr, sendAllTxs, buildSOLBatchIxs, buildTwoPhaseIxBatches]);

  // Keep ref in sync so BroadcastChannel listener and setTimeout can call latest version
  useEffect(() => {
    handleBulkRef.current = handleBulk;
  }, [handleBulk]);

  // ── Row helpers ───────────────────────────────────────────────────────────
  const addRow = () =>
    rows.length < 100 && setRows((p) => [...p, emptyRow()]);
  const removeRow = (id: string) =>
    setRows((p) => p.filter((r) => r.id !== id));
  const updateRow = (id: string, f: "address" | "amount", v: string) =>
    setRows((p) =>
      p.map((r) => (r.id === id ? { ...r, [f]: v, status: "idle" } : r))
    );
  const importCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed: BulkRecipient[] = (ev.target?.result as string)
        .split("\n")
        .filter(Boolean)
        .slice(0, 100)
        .map((line) => {
          const [address, amount] = line.split(",").map((s) => s.trim());
          return {
            id: uid(),
            address: address ?? "",
            amount: amount ?? "",
            status: "idle",
          };
        });
      setRows(parsed);
    };
    reader.readAsText(file);
    e.target.value = "";
  };
  const applyPaste = () => {
    if (!pasteText.trim()) return;
    const parsed = parsePaste(pasteText, pasteDefaultAmount);
    if (parsed.length === 0) return;
    setRows(parsed);
    setShowPasteBox(false);
    setPasteText("");
  };

  // ── Derived stats ─────────────────────────────────────────────────────────
  const validCount = rows.filter((r) => r.address && r.amount).length;
  const successCount = rows.filter((r) => r.status === "success").length;
  const errorCount = rows.filter((r) => r.status === "error").length;
  const selectedToken = walletTokens.find((t) => t.mint === mintAddr);
  const isEmbedded = wallet?.walletClientType === "privy";
  const estAtaBatches = Math.ceil(validCount / BATCH_SIZE_ATA);
  const estTransferBatches = Math.ceil(validCount / BATCH_SIZE_SPL_TRANSFER);

  if (!ready)
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    );

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <span className="brand-icon">⬡</span>
          <span className="brand-name">SolSend</span>
        </div>
        {authenticated && wallet && (
          <div className="header-wallet">
            <div className="wallet-badge">
              <span className="wallet-dot" />
              <span className="wallet-addr">{short(wallet.address)}</span>
              {balance !== null && (
                <span className="wallet-bal">{balance.toFixed(4)} SOL</span>
              )}
              <span className="wallet-type">
                {isEmbedded ? "⚡ Embedded" : wallet.walletClientType}
              </span>
            </div>
            <button className="btn-ghost" onClick={logout}>
              Disconnect
            </button>
          </div>
        )}
      </header>

      <main className="main">
        {!authenticated ? (
          <div className="connect-screen">
            <div className="connect-card">
              <div className="connect-icon">⬡</div>
              <h1 className="connect-title">SolSend</h1>
              <p className="connect-sub">
                Sponsored token transfers on Solana. Single sends or bulk up to
                100 wallets. Gas fees covered automatically via Privy gas
                policy.
              </p>
              <button className="btn-primary connect-btn" onClick={login}>
                Connect Wallet
              </button>
              <div className="connect-features">
                <div className="feature">⚡ Native Gas Sponsorship</div>
                <div className="feature">📦 Bulk Transfer (100 wallets)</div>
                <div className="feature">🪙 SOL + SPL Tokens</div>
                <div className="feature">🔑 Privy Embedded Wallet</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="transfer-ui">
            {isEmbedded ? (
              <div
                className="status-card status-loading"
                style={{ marginBottom: 12 }}
              >
                <span className="status-icon">⚡</span>
                <div className="status-msg">
                  Embedded wallet — gas fully sponsored. Bulk sends run
                  automatically with <strong>zero approval dialogs</strong>.
                </div>
              </div>
            ) : (
              <div
                className="status-card status-error"
                style={{ marginBottom: 12 }}
              >
                <span className="status-icon">⚠️</span>
                <div className="status-msg">
                  External wallet detected. ATA fees (~0.002 SOL each) charged
                  to your wallet. Gas sponsorship only works with Privy embedded
                  wallets.
                </div>
              </div>
            )}

            <div className="tabs">
              <button
                className={`tab ${mode === "single" ? "active" : ""}`}
                onClick={() => setMode("single")}
              >
                Single Transfer
              </button>
              <button
                className={`tab ${mode === "bulk" ? "active" : ""}`}
                onClick={() => setMode("bulk")}
              >
                Bulk Transfer{" "}
                <span className="tab-badge">{rows.length}/100</span>
              </button>
            </div>

            <div className="token-select">
              <button
                className={`token-btn ${tokenType === "SOL" ? "active" : ""}`}
                onClick={() => setTokenType("SOL")}
              >
                ◎ SOL
              </button>
              <button
                className={`token-btn ${tokenType === "SPL" ? "active" : ""}`}
                onClick={() => setTokenType("SPL")}
              >
                🪙 SPL Token
              </button>
            </div>

            {tokenType === "SPL" && (
              <div className="field">
                <label className="label">
                  Token
                  {tokensLoading && (
                    <span className="spinner-sm" style={{ marginLeft: 6 }} />
                  )}
                  {!tokensLoading && walletTokens.length > 0 && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        color: "var(--accent)",
                      }}
                    >
                      {walletTokens.length} token
                      {walletTokens.length !== 1 ? "s" : ""} detected
                    </span>
                  )}
                </label>
                {walletTokens.length > 0 ? (
                  <>
                    <select
                      className="input"
                      value={mintAddr}
                      onChange={(e) => setMintAddr(e.target.value)}
                    >
                      <option value="">— Select token —</option>
                      {walletTokens.map((t) => (
                        <option key={t.mint} value={t.mint}>
                          {t.symbol}
                          {t.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
                            ? " [T22]"
                            : ""}{" "}
                          — {t.balance.toLocaleString()} —{" "}
                          {t.mint.slice(0, 8)}…
                        </option>
                      ))}
                      <option value="__manual__">
                        ✏️ Enter mint manually
                      </option>
                    </select>
                    {selectedToken && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          marginTop: 4,
                        }}
                      >
                        Balance:{" "}
                        <strong>
                          {selectedToken.balance.toLocaleString()}
                        </strong>{" "}
                        · Program:{" "}
                        <span style={{ color: "var(--accent)" }}>
                          {selectedToken.tokenProgramId.equals(
                            TOKEN_2022_PROGRAM_ID
                          )
                            ? "Token-2022"
                            : "Token"}
                        </span>{" "}
                        · Mint:{" "}
                        <span
                          style={{ fontFamily: "monospace", fontSize: 11 }}
                        >
                          {selectedToken.mint}
                        </span>
                      </div>
                    )}
                    {mintAddr === "__manual__" && (
                      <input
                        className="input"
                        style={{ marginTop: 8 }}
                        placeholder="Paste mint address…"
                        value=""
                        onChange={(e) => setMintAddr(e.target.value)}
                      />
                    )}
                  </>
                ) : (
                  <input
                    className="input"
                    placeholder={
                      tokensLoading
                        ? "Scanning wallet…"
                        : "e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                    }
                    value={mintAddr}
                    onChange={(e) => setMintAddr(e.target.value)}
                    disabled={tokensLoading}
                  />
                )}
              </div>
            )}

            {mode === "single" && (
              <div className="single-form">
                <div className="field">
                  <label className="label">Recipient Address</label>
                  <input
                    className="input"
                    placeholder="Solana wallet address…"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label">Amount ({tokenType})</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  {tokenType === "SPL" && selectedToken && (
                    <button
                      className="btn-ghost"
                      style={{ marginTop: 4, fontSize: 12 }}
                      onClick={() =>
                        setAmount(String(selectedToken.balance))
                      }
                    >
                      Max: {selectedToken.balance.toLocaleString()}
                    </button>
                  )}
                </div>
                <button
                  className="btn-primary send-btn"
                  onClick={handleSingle}
                  disabled={
                    txStatus.type === "loading" ||
                    !recipient ||
                    !amount ||
                    (tokenType === "SPL" &&
                      (!mintAddr || mintAddr === "__manual__"))
                  }
                >
                  {txStatus.type === "loading" ? (
                    <>
                      <span className="spinner-sm" /> Sending…
                    </>
                  ) : (
                    "Send Transaction ⚡"
                  )}
                </button>
                {txStatus.type !== "idle" && (
                  <div className={`status-card status-${txStatus.type}`}>
                    <span className="status-icon">
                      {txStatus.type === "success"
                        ? "✓"
                        : txStatus.type === "error"
                        ? "✗"
                        : "⏳"}
                    </span>
                    <div>
                      <div className="status-msg">{txStatus.message}</div>
                      {txStatus.txHash && (
                        <a
                          href={explorerUrl(txStatus.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="tx-link"
                        >
                          View on Explorer →
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {mode === "bulk" && (
              <div className="bulk-form">
                <div className="bulk-controls">
                  <div className="bulk-stats">
                    <span className="stat">{validCount} ready</span>
                    {successCount > 0 && (
                      <span className="stat stat-success">
                        ✓ {successCount}
                      </span>
                    )}
                    {errorCount > 0 && (
                      <span className="stat stat-error">✗ {errorCount}</span>
                    )}
                  </div>
                  <div className="bulk-actions">
                    <button
                      className="btn-ghost"
                      onClick={() => setShowPasteBox((v) => !v)}
                      disabled={bulkRunning}
                    >
                      📋 Paste Wallets
                    </button>
                    <label className="btn-ghost csv-label">
                      Import CSV
                      <input
                        type="file"
                        accept=".csv"
                        onChange={importCSV}
                        style={{ display: "none" }}
                      />
                    </label>
                    <button
                      className="btn-ghost"
                      onClick={addRow}
                      disabled={rows.length >= 100}
                    >
                      + Add Row
                    </button>
                  </div>
                </div>

                {showPasteBox && (
                  <div
                    style={{
                      background: "var(--surface-2, #1a1a2e)",
                      border: "1px solid var(--border, #333)",
                      borderRadius: 10,
                      padding: "14px 16px",
                      marginBottom: 12,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 8,
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 13 }}>
                        📋 Paste Wallets
                      </span>
                      <button
                        className="btn-ghost"
                        style={{ fontSize: 11 }}
                        onClick={() => {
                          setShowPasteBox(false);
                          setPasteText("");
                        }}
                      >
                        ✕ Close
                      </button>
                    </div>
                    <p
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted, #888)",
                        marginBottom: 8,
                        lineHeight: 1.5,
                      }}
                    >
                      One address per line. Supports: <code>address</code>,{" "}
                      <code>address,amount</code>, or{" "}
                      <code>address&nbsp;&nbsp;amount</code>. Max 100 wallets.
                      Replaces current rows.
                    </p>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <label style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                        Default amount ({tokenType}):
                      </label>
                      <input
                        className="input input-sm input-amount"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0.00"
                        value={pasteDefaultAmount}
                        onChange={(e) => setPasteDefaultAmount(e.target.value)}
                        style={{ maxWidth: 120 }}
                      />
                    </div>
                    <textarea
                      className="input"
                      style={{
                        width: "100%",
                        minHeight: 180,
                        fontFamily: "monospace",
                        fontSize: 11,
                        resize: "vertical",
                        boxSizing: "border-box",
                      }}
                      placeholder={`H48sSi6yo2M4jz5tTyRKnu3Uw6CPfErgoJmBkjZDPXFc\n3qQtsNzaRyus5BVnLsUHNnvH2bSTykg5MPtsFA224eFU\n...\n\nOr with amounts:\nH48sSi6yo2M4jz5tTyRKnu3Uw6CPfErgoJmBkjZDPXFc, 0.01`}
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      spellCheck={false}
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 10,
                        alignItems: "center",
                      }}
                    >
                      <button
                        className="btn-primary"
                        style={{ flex: 1 }}
                        onClick={applyPaste}
                        disabled={!pasteText.trim()}
                      >
                        Load{" "}
                        {parsePaste(pasteText, pasteDefaultAmount).length}{" "}
                        Wallet
                        {parsePaste(pasteText, pasteDefaultAmount).length !== 1
                          ? "s"
                          : ""}{" "}
                        →
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => setPasteText("")}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}

                <div className="csv-hint">
                  CSV format: address,amount — one per line, max 100 rows
                </div>

                {bulkRunning && phaseMsg && (
                  <div
                    className="status-card status-loading"
                    style={{ marginBottom: 10 }}
                  >
                    <span className="spinner-sm" />
                    <div className="status-msg">{phaseMsg}</div>
                  </div>
                )}

                {bulkRunning && (
                  <div className="progress-wrap">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="progress-pct">{progress}%</span>
                  </div>
                )}

                <div className="bulk-list">
                  <div className="bulk-header">
                    <span>#</span>
                    <span>Address</span>
                    <span>Amount</span>
                    <span>Status</span>
                    <span />
                  </div>
                  {rows.map((r, i) => (
                    <div key={r.id} className={`bulk-row bulk-row-${r.status}`}>
                      <span className="row-num">{i + 1}</span>
                      <input
                        className="input input-sm"
                        placeholder="Solana address…"
                        value={r.address}
                        onChange={(e) =>
                          updateRow(r.id, "address", e.target.value)
                        }
                        disabled={bulkRunning}
                      />
                      <input
                        className="input input-sm input-amount"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0.00"
                        value={r.amount}
                        onChange={(e) =>
                          updateRow(r.id, "amount", e.target.value)
                        }
                        disabled={bulkRunning}
                      />
                      <span className={`row-status row-status-${r.status}`}>
                        {r.status === "idle" && "–"}
                        {r.status === "pending" && (
                          <span className="spinner-sm" />
                        )}
                        {r.status === "success" && (
                          <a
                            href={explorerUrl(r.txHash!)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={r.txHash}
                          >
                            ✓
                          </a>
                        )}
                        {r.status === "error" && (
                          <span title={r.error}>✗</span>
                        )}
                      </span>
                      <button
                        className="row-remove"
                        onClick={() => removeRow(r.id)}
                        disabled={bulkRunning}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                {validCount > 0 && !bulkRunning && tokenType === "SPL" && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted, #888)",
                      textAlign: "center",
                      marginBottom: 6,
                      lineHeight: 1.6,
                    }}
                  >
                    {!isEmbedded ? (
                      <>
                        ⚡ <strong>2 approvals total</strong> — approve once
                        for ATAs ({estAtaBatches} tx
                        {estAtaBatches !== 1 ? "s" : ""}), approve once for
                        transfers ({estTransferBatches} tx
                        {estTransferBatches !== 1 ? "s" : ""}).
                      </>
                    ) : (
                      <>
                        ⚡ <strong>Zero approval dialogs</strong> — click Send
                        and all {estAtaBatches + estTransferBatches} txs fire
                        automatically.{" "}
                        <span style={{ color: "#14F195" }}>
                          Gas sponsored ✓
                        </span>
                      </>
                    )}
                  </div>
                )}

                {validCount > 0 && !bulkRunning && tokenType === "SOL" && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted, #888)",
                      textAlign: "center",
                      marginBottom: 6,
                    }}
                  >
                    {!isEmbedded ? (
                      <>
                        ⚡ <strong>1 approval</strong> → {validCount} wallet
                        {validCount !== 1 ? "s" : ""} across{" "}
                        {Math.ceil(validCount / BATCH_SIZE_SOL)} tx
                        {Math.ceil(validCount / BATCH_SIZE_SOL) !== 1
                          ? "s"
                          : ""}
                      </>
                    ) : (
                      <>
                        ⚡ <strong>Zero approval dialogs</strong> — click Send
                        and all {Math.ceil(validCount / BATCH_SIZE_SOL)} txs
                        fire automatically. Gas sponsored ✓
                      </>
                    )}
                  </div>
                )}

                <button
                  className="btn-primary send-btn"
                  onClick={() => {
                    isAutoRetryRef.current = false;
                    handleBulk();
                  }}
                  disabled={
                    bulkRunning ||
                    validCount === 0 ||
                    (tokenType === "SPL" &&
                      (!mintAddr || mintAddr === "__manual__"))
                  }
                >
                  {bulkRunning ? (
                    <>
                      <span className="spinner-sm" />{" "}
                      {phaseMsg || "Processing…"}
                    </>
                  ) : tokenType === "SPL" ? (
                    !isEmbedded ? (
                      `Send to ${validCount} Wallet${
                        validCount !== 1 ? "s" : ""
                      } · 2 Approvals ⚡`
                    ) : (
                      `Send to ${validCount} Wallet${
                        validCount !== 1 ? "s" : ""
                      } · No Approvals ⚡`
                    )
                  ) : !isEmbedded ? (
                    `Send to ${validCount} Wallet${
                      validCount !== 1 ? "s" : ""
                    } · 1 Approval ⚡`
                  ) : (
                    `Send to ${validCount} Wallet${
                      validCount !== 1 ? "s" : ""
                    } · No Approvals ⚡`
                  )}
                </button>
              </div>
            )}

            <div className="sponsor-note">
              ⚡ Gas fees sponsored via Privy native gas policy — embedded
              wallet users pay nothing.
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#14F195",
          walletChainType: "solana-only",
        },
        loginMethods: ["email", "wallet", "google", "twitter"],
        solana: {
          rpcs: {
            "solana:mainnet": {
              rpc: createSolanaRpc(
                "https://solana-mainnet.g.alchemy.com/v2/nRR5_ECTUtjWlB8iSu59C"
              ),
              rpcSubscriptions: createSolanaRpcSubscriptions(
                "wss://solana-mainnet.g.alchemy.com/v2/nRR5_ECTUtjWlB8iSu59C"
              ),
            },
          },
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors(),
          },
        },
      }}
    >
      <InnerApp />
    </PrivyProvider>
  );
}