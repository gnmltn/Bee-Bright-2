# Connect MetaMask and Blockchain to Bee Bright – Step by Step

You need **MetaMask** with an imported account (e.g. **Imported Account 1** from Ganache). Follow these steps in order.

---

## Step 1: Add the Ganache network in MetaMask (if you haven’t)

1. In MetaMask, click the **network dropdown** at the top (e.g. "Ethereum Mainnet" or "Sepolia").
2. Click **"Add network"** or **"Add a network manually"**.
3. Enter exactly:
   - **Network name:** `Ganache Bee Bright`
   - **RPC URL:** `http://127.0.0.1:7545` (must include `http://`)
   - **Chain ID:** `1337` (use `5777` only if your Ganache UI shows **Network ID 5777**)
   - **Currency symbol:** `ETH`
4. Click **Save**.

---

## Step 2: Switch to Ganache and check balance

1. In the network dropdown, select **"Ganache Bee Bright"**.
2. Click **Imported Account 1** (or the account you use) so it’s the active account.
3. You should see **100 ETH** (or close to it). If you see 0, **start Ganache** (desktop app) and try again.

---

## Step 3: Deploy the contract in Remix

1. Open your browser and go to: **https://remix.ethereum.org**
2. On the left, under **File Explorers**, create a new file. Name it: **`BeeBrightPayments.sol`** (you can put it in a `contracts` folder if Remix has one).
3. On your computer, open this project folder and open: **`contracts/BeeBrightPayments.sol`**. Copy **all** the code from that file.
4. In Remix, paste the code into `BeeBrightPayments.sol`. Press **Ctrl+S** to save.
5. Click the **Solidity compiler** icon on the left. Set the compiler to **0.8.26** (or any 0.8.x). Click **"Compile BeeBrightPayments.sol"**. Wait for the green checkmark.
6. Click the **Deploy & run transactions** icon.
7. At the top, set **Environment** to **"Injected Provider - MetaMask"**. If Remix asks to connect MetaMask, click **Connect**.
8. Make sure MetaMask is on **"Ganache Bee Bright"** and **Imported Account 1** is selected.
9. Above the pink **Deploy** button there is a box for the **constructor** (`_beeBrightWallet`). In that box type exactly:
   ```
   0x636b0b5c129f88baea59969D3E6b0b41046dD810
   ```
   (This is the **Bee Bright wallet** address that will receive the ETH – use your Ganache account address if different.)
10. Click the pink **Deploy** button.
11. MetaMask will pop up – click **Confirm**.
12. Wait a few seconds. Under **Deployed Contracts** in Remix you’ll see something like **BEEBRIGHTPAYMENTS at 0x1234...**
13. **Copy that contract address** (click the copy icon). Paste it into Notepad for the next step.

---

## Step 4: Put the contract address in your backend

1. Open your project folder. Go to **`backend`** and open **`.env`**.
2. Find the line:
   ```
   BEEBRIGHT_PAYMENTS_CONTRACT=
   ```
3. Paste the address you copied from Remix after the `=`:
   ```
   BEEBRIGHT_PAYMENTS_CONTRACT=0xYourPastedAddressFromRemix
   ```
4. Save the file.
5. **Restart your backend:** In the terminal where the backend runs, press **Ctrl+C**, then start it again (e.g. `npm run dev` in the `backend` folder).

---

## Step 5: Pay with blockchain in your app

1. Make sure **Ganache** is running.
2. Make sure **MetaMask** is on **"Ganache Bee Bright"** and **Imported Account 1** is selected (the one with 100 ETH).
3. Open your Bee Bright app in the browser (e.g. http://localhost:8080).
4. Complete **Enrollment** (Personal Info → Select Services → Confirmation), then click **Pay Down Payment** or **Pay Full Amount**.
5. You should see **"Blockchain Payment - Bee Bright"** and **"Pay with Blockchain (Ganache)"**. Click **Pay X ETH** (X is the amount in ETH).
6. MetaMask will ask to connect (if not already) and then show a **transaction request**. Click **Confirm**.
7. Wait for the success message. You can then optionally upload a screenshot for admin verification and click **Done**.

---

## Quick checklist

- [ ] Step 1: Ganache network added in MetaMask  
- [ ] Step 2: Switched to **Ganache Bee Bright**, account shows ~100 ETH  
- [ ] Step 3: Contract deployed in Remix, contract address copied  
- [ ] Step 4: Address pasted in **backend/.env** as `BEEBRIGHT_PAYMENTS_CONTRACT=0x...`, backend restarted  
- [ ] Step 5: Student paid via **Pay X ETH** in the enrollment flow  

---

## If your Ganache uses Network ID 5777

In **backend/.env** set:

```
GANACHE_CHAIN_ID=5777
```

Then in MetaMask, when adding the network, use **Chain ID: 5777** instead of 1337.

---

If you get stuck, say which step number you’re on and what you see on the screen.
