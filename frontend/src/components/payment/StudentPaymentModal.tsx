import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle, Upload, Wallet, Smartphone, QrCode } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { paymentService } from "@/services/api";
import gcashQrFallback from "@/assets/qr.jpg";
import beeBrightLogo from "@/assets/bee-mascot.png";
import { BrowserProvider, Contract, parseEther, keccak256, toUtf8Bytes } from "ethers";

/** ABI for BeeBrightPayments.sol – pay(bytes32 enrollmentRef) payable */
const BEEBRIGHT_PAYMENTS_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "enrollmentRef", type: "bytes32" }],
    name: "pay",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export interface PaymentSessionData {
  paymentId: string;
  amount: number;
  paymentMethod: "gcash" | "blockchain";
  amountEth?: number;
  contractAddress?: string;
  recipientAddress?: string;
  chainId?: number;
  phpPerEth?: number;
  referenceNumber: string;
  checkoutToken?: string | null;
  gcash?: {
    accountNumber: string;
    accountName: string;
    qrImageDataUrl?: string;
    qrImageUrl?: string;
    instructions?: string[];
  };
}

export type BlockchainPaymentData = PaymentSessionData;

interface CheckoutStudentDraft {
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  gradeLevel: string;
  guardianName: string;
  guardianPhone?: string;
}

interface StudentPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  enrollmentId?: string;
  paymentSession?: PaymentSessionData | null;
  preferredPaymentMethod?: "gcash" | "blockchain";
  checkoutStudent?: CheckoutStudentDraft;
  studentId?: string;
  studentName?: string;
  email?: string;
  amount: number;
  paymentOption: "down" | "full";
  onPaymentComplete: () => void;
}

const GANACHE_CHAIN_ID = 1337;

const StudentPaymentModal: React.FC<StudentPaymentModalProps> = ({
  isOpen,
  onClose,
  enrollmentId,
  paymentSession,
  preferredPaymentMethod = "blockchain",
  checkoutStudent,
  studentName,
  amount,
  paymentOption,
  onPaymentComplete
}) => {
  const [step, setStep] = useState<"pay" | "upload" | "success">("pay");
  const [isLoading, setIsLoading] = useState(false);
  const [paymentData, setPaymentData] = useState<PaymentSessionData | null>(null);
  const [paymentInitLoading, setPaymentInitLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [gcashInfo, setGcashInfo] = useState<PaymentSessionData["gcash"] | null>(null);
  const [gcashReference, setGcashReference] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string>("");
  const [hasRestoredModalState, setHasRestoredModalState] = useState(false);
  const { toast } = useToast();
  const stepRef = useRef<"pay" | "upload" | "success">("pay");
  const lastBackToastAtRef = useRef(0);
  const modalStorageKey = useMemo(() => {
    const id = paymentData?.paymentId || paymentSession?.paymentId;
    return id ? `beebright-payment-modal:${id}` : null;
  }, [paymentData?.paymentId, paymentSession?.paymentId]);

  const clearStoredModalState = useCallback(() => {
    if (modalStorageKey) {
      sessionStorage.removeItem(modalStorageKey);
    }
  }, [modalStorageKey]);

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // Initiate payment when modal opens.
  useEffect(() => {
    let cancelled = false;
    setPaymentData(null);
    setGcashInfo(null);
    setGcashReference("");
    setScreenshotFile(null);
    setScreenshotPreview("");

    if (!isOpen) {
      setHasRestoredModalState(false);
      return () => { cancelled = true; };
    }

    let restoredStep: "pay" | "upload" | "success" = "pay";
    let restoredTxHash: string | null = null;
    let restoredWalletAddress: string | null = null;

    if (modalStorageKey) {
      try {
        const savedState = sessionStorage.getItem(modalStorageKey);
        if (savedState) {
          const parsed = JSON.parse(savedState);
          if (parsed.step === "pay" || parsed.step === "upload" || parsed.step === "success") {
            restoredStep = parsed.step;
          }
          if (typeof parsed.txHash === "string" && parsed.txHash) {
            restoredTxHash = parsed.txHash;
          }
          if (typeof parsed.walletAddress === "string" && parsed.walletAddress) {
            restoredWalletAddress = parsed.walletAddress;
          }
        }
      } catch (_) {
        sessionStorage.removeItem(modalStorageKey);
      }
    }

    setStep(restoredStep);
    setTxHash(restoredTxHash);
    setWalletAddress(restoredWalletAddress);
    setHasRestoredModalState(true);

    if (paymentSession?.paymentId) {
      setPaymentData(paymentSession);
      if (paymentSession.gcash) {
        setGcashInfo(paymentSession.gcash);
      }
      setPaymentInitLoading(false);
      return () => { cancelled = true; };
    }

    if (!enrollmentId) return () => { cancelled = true; };

    setPaymentInitLoading(true);
    paymentService
      .initiateStudentPayment(enrollmentId, preferredPaymentMethod)
      .then((res) => {
        if (cancelled || !res.data?.success) return;
        const p = res.data.payment;
        const method = p?.paymentMethod === "gcash" ? "gcash" : "blockchain";
        const b = res.data.blockchain;
        const g = res.data.gcash;
        if (!p?.id && !p?._id) return;
        setPaymentData({
          paymentId: (p.id || p._id).toString(),
          amount: Number(p.amount || amount),
          paymentMethod: method,
          amountEth: b?.amountEth,
          contractAddress: b?.contractAddress || "",
          recipientAddress: b?.recipientAddress || "",
          chainId: b?.chainId ?? GANACHE_CHAIN_ID,
          phpPerEth: b?.phpPerEth || 250000,
          referenceNumber: p?.referenceNumber || b?.referenceNumber || "",
          gcash: g || undefined,
          checkoutToken: p?.checkoutToken || null,
        });
        if (g) {
          setGcashInfo(g);
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({
            title: "Payment session error",
            description: "Could not start payment. Please try again.",
            variant: "destructive",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setPaymentInitLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, enrollmentId, paymentSession, amount, modalStorageKey, preferredPaymentMethod, toast]);

  useEffect(() => {
    if (!isOpen) return;
    if (paymentData?.paymentMethod !== "gcash" && preferredPaymentMethod !== "gcash") return;

    let cancelled = false;
    paymentService
      .getGcashInfo()
      .then((res) => {
        if (cancelled || !res.data?.success || !res.data?.gcash) return;
        setGcashInfo((prev) => prev || res.data.gcash);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isOpen, paymentData?.paymentMethod, preferredPaymentMethod]);

  useEffect(() => {
    if (!isOpen || !modalStorageKey || !hasRestoredModalState) return;

    sessionStorage.setItem(
      modalStorageKey,
      JSON.stringify({
        step,
        txHash,
        walletAddress,
      })
    );
  }, [hasRestoredModalState, isOpen, modalStorageKey, step, txHash, walletAddress]);

  useEffect(() => {
    if (!isOpen) return;

    const keepPaymentOpen = () => {
      window.history.pushState(
        { ...(window.history.state || {}), beebrightPaymentModal: true },
        "",
        window.location.href
      );
    };

    keepPaymentOpen();

    const showBackBlockedMessage = () => {
      const now = Date.now();
      if (now - lastBackToastAtRef.current < 1200) return;
      lastBackToastAtRef.current = now;

      if (stepRef.current === "upload") {
        toast({
          title: "Back is blocked",
          description: "You can't go back. Please submit your screenshot proof of payment to proceed.",
          variant: "destructive",
        });
        return;
      }

      if (stepRef.current === "pay") {
        toast({
          title: "Back is blocked",
          description: "You can't go back. Please complete this payment step first.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Back is blocked",
        description: "Finish this payment flow before leaving this page.",
        variant: "destructive",
      });
    };

    const handlePopState = () => {
      if (!isOpen) return;
      showBackBlockedMessage();
      keepPaymentOpen();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isOpen]);

  /** Connect MetaMask only (accounts + correct network). Opens MetaMask for user to verify. */
  const connectMetaMask = async () => {
    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) {
      toast({
        title: "MetaMask not found",
        description: "Please install MetaMask and refresh the page.",
        variant: "destructive",
      });
      return;
    }
    if (!paymentData?.chainId) return;
    setIsLoading(true);
    toast({
      title: "Opening MetaMask",
      description: "Approve the connection in the MetaMask window.",
    });
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.length) {
        toast({ title: "No account", description: "Please unlock MetaMask and connect an account.", variant: "destructive" });
        return;
      }
      setWalletAddress(accounts[0]);
      const provider = new BrowserProvider(eth);
      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);
      if (chainId !== paymentData.chainId) {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${paymentData.chainId.toString(16)}` }],
        });
      }
      toast({ title: "Connected", description: "MetaMask is connected. You can now pay." });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not connect";
      const isRejected = /rejected|denied/i.test(msg);
      toast({
        title: isRejected ? "Connection cancelled" : "Connection failed",
        description: isRejected ? "Please connect MetaMask when prompted." : msg,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const connectAndPay = async () => {
    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) {
      toast({
        title: "MetaMask not found",
        description: "Please install MetaMask and refresh the page.",
        variant: "destructive",
      });
      return;
    }

    const payToContract = Boolean(paymentData?.contractAddress);
    const payToAddress = paymentData?.recipientAddress;
    if (!payToContract && !payToAddress) {
      toast({
        title: "Configuration error",
        description: "Set BEEBRIGHT_PAYMENTS_CONTRACT in backend .env (Step 4). Deploy BeeBrightPayments.sol in Remix first.",
        variant: "destructive",
      });
      return;
    }
    if (!walletAddress) {
      toast({
        title: "Connect first",
        description: "Please click Connect MetaMask before paying.",
        variant: "destructive",
      });
      return;
    }

    const valueWei = parseEther(paymentData!.amountEth.toFixed(6));

    setIsLoading(true);
    try {
      const provider = new BrowserProvider(eth);
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.length) {
        toast({ title: "No account", description: "Please unlock MetaMask and connect an account.", variant: "destructive" });
        return;
      }
      setWalletAddress(accounts[0]);

      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);
      if (chainId !== paymentData!.chainId) {
        try {
          await eth.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${paymentData!.chainId.toString(16)}` }],
          });
        } catch (switchErr: unknown) {
          const msg = (switchErr as { message?: string })?.message || "";
          const netId = paymentData!.chainId === 5777 ? "5777" : "1337";
          if (msg.includes("add the chain") || msg.includes("Unrecognized")) {
            toast({
              title: "Wrong network",
              description: `Add "Ganache Bee Bright" in MetaMask: RPC http://127.0.0.1:7545, Chain ID ${netId}.`,
              variant: "destructive",
            });
          } else {
            toast({ title: "Switch network", description: "Please switch to Ganache Bee Bright in MetaMask.", variant: "destructive" });
          }
          return;
        }
      }

      const signer = await provider.getSigner();
      let tx: { hash: string; wait: () => Promise<unknown> };

      if (payToContract) {
        const ref = paymentData!.referenceNumber;
        if (!ref) {
          toast({
            title: "Payment error",
            description: "Missing enrollment reference. Please try again.",
            variant: "destructive",
          });
          return;
        }
        const enrollmentRef = keccak256(toUtf8Bytes(ref)) as `0x${string}`;
        const contract = new Contract(
          paymentData!.contractAddress,
          BEEBRIGHT_PAYMENTS_ABI,
          signer
        );
        tx = await contract.pay(enrollmentRef, { value: valueWei, gasLimit: 100000 }) as { hash: string; wait: () => Promise<unknown> };
      } else {
        tx = await signer.sendTransaction({
          to: paymentData!.recipientAddress,
          value: valueWei,
          gasLimit: 50000,
        });
      }
      setTxHash(tx.hash);
      await tx.wait();

      toast({
        title: "Payment confirmed",
        description: "Your blockchain payment was successful. Upload the screenshot to finish enrollment review.",
      });
      setStep("upload");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transaction failed";
      const isRejected = /rejected|denied|user denied/i.test(message);
      toast({
        title: isRejected ? "Transaction cancelled" : "Payment failed",
        description: isRejected ? "You rejected the transaction in MetaMask." : message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({ title: "File too large", description: "Please upload an image smaller than 5MB", variant: "destructive" });
        return;
      }
      const allowedTypes = ["image/jpeg", "image/jpg", "image/png"];
      if (!allowedTypes.includes(file.type.toLowerCase())) {
        toast({ title: "Invalid file type", description: "Please upload JPG or PNG image only", variant: "destructive" });
        return;
      }
      setScreenshotFile(file);
      const reader = new FileReader();
      reader.onloadend = () => setScreenshotPreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleSubmitProof = async () => {
    const paymentId = paymentData?.paymentId;
    if (!paymentId) return;
    if (!screenshotFile) {
      toast({ title: "Screenshot required", description: "Please upload a payment screenshot before submitting.", variant: "destructive" });
      return;
    }

    try {
      setIsLoading(true);
      const body: {
        transactionHash?: string;
        fromAddress?: string;
        amountEth?: number;
        mobileNumber?: string;
        transactionId?: string;
        screenshotUrl?: string;
        checkoutToken?: string;
        checkoutStudent?: CheckoutStudentDraft;
      } = {};

      if (paymentData?.paymentMethod === "blockchain") {
        body.transactionHash = txHash || undefined;
        body.fromAddress = walletAddress || undefined;
        body.amountEth = paymentData?.amountEth;
      } else {
        body.mobileNumber = gcashInfo?.accountNumber || "09307517208";
        body.transactionId = gcashReference.trim() || undefined;
      }
      if (paymentData?.checkoutToken) {
        body.checkoutToken = paymentData.checkoutToken;
      }
      if (checkoutStudent) {
        body.checkoutStudent = checkoutStudent;
      }
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(screenshotFile);
      });
      body.screenshotUrl = base64;

      const response = await paymentService.submitPaymentProof(paymentId, body);
      if (response.data.success) {
        setStep("success");
        toast({ title: "Success", description: "Proof submitted. Admin will review your enrollment." });
      } else {
        toast({
          title: "Submission failed",
          description: (response.data as { message?: string }).message || "Failed to submit proof",
          variant: "destructive",
        });
      }
    } catch (error: unknown) {
      const msg =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        "Failed to submit proof";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const goToSuccess = () => {
    setStep("success");
    toast({ title: "Done", description: "Your payment is recorded. Admin will review your enrollment." });
  };

  const renderPayStep = () => (
    <div className="space-y-5">
      <div className="text-center">
        <h3 className="text-xl font-bold text-foreground">
          {paymentData?.paymentMethod === "gcash" ? "Pay with GCash" : "Pay with Blockchain (Ganache)"}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          {paymentData?.paymentMethod === "gcash"
            ? "Use the official BeeBright GCash details below, then upload your proof screenshot."
            : "Secure payment on the blockchain. Connect MetaMask and pay with ETH."}
        </p>
      </div>

      <div className="bg-muted/60 p-4 rounded-lg border border-border space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Amount (₱)</p>
            <p className="text-lg font-bold text-primary">₱{amount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {paymentData?.paymentMethod === "gcash" ? "Payment Method" : "Amount (ETH)"}
            </p>
            <p className="text-lg font-bold text-primary">
              {paymentData?.paymentMethod === "gcash"
                ? "GCash"
                : `${paymentData?.amountEth != null ? paymentData.amountEth.toFixed(6) : "—"} ETH`}
            </p>
          </div>
        </div>
        {studentName && (
          <p className="text-sm text-muted-foreground border-t border-border pt-2">Student: {studentName}</p>
        )}
      </div>

      {paymentData?.paymentMethod === "gcash" ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Smartphone className="h-5 w-5 text-primary" />
              <p className="font-semibold text-foreground">GCash Account Details</p>
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">GCash Number: <span className="font-semibold text-foreground">{gcashInfo?.accountNumber || "09307517208"}</span></p>
              <p className="text-muted-foreground">Account Name: <span className="font-semibold text-foreground">{gcashInfo?.accountName || "BeeBright"}</span></p>
            </div>
            {(gcashInfo?.qrImageDataUrl || gcashInfo?.qrImageUrl || gcashQrFallback) ? (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <QrCode className="h-4 w-4 text-primary" />
                  <p className="text-sm font-medium text-foreground">GCash QR Code</p>
                </div>
                <img
                  src={gcashQrFallback}
                  alt="BeeBright GCash QR"
                  className="mx-auto max-h-56 rounded-md border border-border"
                />
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <p className="font-semibold text-foreground mb-2">Payment Steps</p>
            <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
              {(gcashInfo?.instructions?.length ? gcashInfo.instructions : [
                "Step 1 - Open GCash App",
                "Step 2 - Send payment to the provided number or scan QR",
                "Step 3 - Enter exact amount shown in system",
                "Step 4 - Complete payment",
                "Step 5 - Upload payment screenshot as proof",
              ]).map((stepText, idx) => (
                <li key={`${idx}-${stepText}`}>{stepText}</li>
              ))}
            </ol>
          </div>

          <Button
            onClick={() => setStep("upload")}
            disabled={isLoading || paymentInitLoading}
            className="w-full"
            size="lg"
          >
            I completed GCash payment
          </Button>
        </div>
      ) : (
        <>

      {/* MetaMask section: Connect button or Connected status (like original project design) */}
      <div className="p-4 rounded-lg border border-border bg-muted/40 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">MetaMask</p>
        {walletAddress ? (
          <div className="flex items-center gap-3">
            <img
              src="https://metamask.io/images/metamask-fox.svg"
              alt="MetaMask"
              className="h-9 w-9 shrink-0"
            />
            <p className="text-sm font-medium text-foreground">Connected: {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</p>
          </div>
        ) : (
          <Button
            onClick={connectMetaMask}
            disabled={isLoading || paymentInitLoading}
            variant="outline"
            className="w-full border-orange-500 text-orange-600 hover:bg-orange-500/10 hover:text-orange-700"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting…
              </>
            ) : (
              "Connect MetaMask"
            )}
          </Button>
        )}
      </div>

      {/* Pay ETH – only when connected */}
      {walletAddress && (
        <Button
          onClick={connectAndPay}
          disabled={isLoading || paymentInitLoading || !(paymentData?.contractAddress || paymentData?.recipientAddress)}
          className="w-full bg-gradient-to-r from-orange-600 to-yellow-600 hover:from-orange-700 hover:to-yellow-700"
          size="lg"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing…
            </>
          ) : (
            <>
              <Wallet className="mr-2 h-4 w-4" />
              Pay {paymentData?.amountEth != null ? paymentData.amountEth.toFixed(6) : "—"} ETH
            </>
          )}
        </Button>
      )}
        </>
      )}
    </div>
  );

  const renderUploadStep = () => (
    <div className="space-y-5">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-orange-500 to-yellow-500 mb-3">
          <Upload className="h-7 w-7 text-white" />
        </div>
        <h3 className="text-lg font-bold text-foreground">Submit proof of payment</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Upload your payment screenshot. The admin will manually verify and approve or reject your enrollment.
        </p>
      </div>

      {paymentData?.paymentMethod === "blockchain" && txHash && (
        <div className="bg-muted/60 p-3 rounded-lg text-sm">
          <p className="text-muted-foreground">Transaction</p>
          <p className="font-mono break-all text-foreground">{txHash}</p>
        </div>
      )}

      {paymentData?.paymentMethod === "gcash" && (
        <div>
          <Label htmlFor="gcashReference">GCash Reference Number (optional)</Label>
          <Input
            id="gcashReference"
            value={gcashReference}
            onChange={(event) => setGcashReference(event.target.value)}
            placeholder="Enter GCash reference/transaction number"
            className="mt-2"
          />
        </div>
      )}

      <div>
        <Label htmlFor="screenshot">Payment Screenshot *</Label>
        <div className="mt-2 border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-primary/50 transition-colors">
          <Input
            id="screenshot"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <label htmlFor="screenshot" className="cursor-pointer">
            <Upload className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-foreground font-medium">Click to upload payment screenshot (required)</p>
            <p className="text-sm text-muted-foreground mt-1">JPG or PNG up to 5MB</p>
          </label>
        </div>
        {screenshotPreview && (
          <div className="mt-4">
            <img src={screenshotPreview} alt="Preview" className="max-h-48 mx-auto rounded shadow-sm" />
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <Button
          onClick={handleSubmitProof}
          disabled={isLoading || !screenshotFile}
          className="w-full bg-gradient-to-r from-orange-600 to-yellow-600"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting…
            </>
          ) : (
            <>Submit proof for verification</>
          )}
        </Button>
      </div>
    </div>
  );

  const renderSuccessStep = () => (
    <div className="space-y-5 text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 200 }}
        className="w-20 h-20 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center mx-auto"
      >
        <CheckCircle className="h-10 w-10 text-orange-600" />
      </motion.div>
      <h3 className="text-xl font-bold text-foreground">Proof submitted</h3>
      <p className="text-sm text-muted-foreground">
        Your payment proof has been submitted successfully. The admin will review and approve or reject your enrollment.
      </p>
      <div className="bg-muted/60 p-4 rounded-lg text-left text-sm">
        <h4 className="font-medium text-foreground mb-2">What happens next?</h4>
        <ul className="space-y-1.5 text-muted-foreground">
          <li>• Admin will review your screenshot and <strong className="text-foreground">approve</strong> or <strong className="text-foreground">reject</strong> your enrollment.</li>
          <li>• Your payment status is now pending verification.</li>
          <li>• If approved, you will be able to log in to the student portal.</li>
        </ul>
      </div>
      <Button
        onClick={() => {
          clearStoredModalState();
          onPaymentComplete();
        }}
        className="w-full"
        size="lg"
      >
        Done
        <CheckCircle className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) {
        clearStoredModalState();
        onClose();
      }
    }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src={beeBrightLogo} alt="Bee Bright" className="w-8 h-8 rounded-full object-cover" />
            {paymentData?.paymentMethod === "gcash" ? "GCash Payment - Bee Bright" : "Blockchain Payment - Bee Bright"}
          </DialogTitle>
          <DialogDescription>
            {paymentData?.paymentMethod === "gcash" ? "Follow the GCash instructions and upload your screenshot proof." : "Connect MetaMask and pay with ETH on Ganache"}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          {paymentInitLoading && !paymentData ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Starting payment…</span>
            </div>
          ) : (
            <>
              {step === "pay" && renderPayStep()}
              {step === "upload" && renderUploadStep()}
              {step === "success" && renderSuccessStep()}
            </>
          )}
        </div>
        <div className="text-xs text-muted-foreground text-center border-t pt-4">
          <p>Need help? Email <a href="mailto:payments@beebright.com" className="text-primary hover:underline">payments@beebright.com</a></p>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default StudentPaymentModal;
