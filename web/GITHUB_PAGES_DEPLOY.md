# GitHub Pages 部署與上線前檢查

本專案已加入 GitHub Actions 部署流程：推送到 `main` 後，GitHub 會安裝 Web 專案依賴、建置 `web/dist`，再將產物部署至 GitHub Pages。手動執行也可在 Actions 頁面選擇 `Deploy PDF Editor to GitHub Pages` 工作流程並按 Run workflow。

Git 只追蹤 `web/`、必要的 `.github/workflows/deploy.yml` 與根目錄 `.gitignore`。專案外層的 Python、舊版 HTML、PDF 與說明文件會保留在本機，但從下一次提交起不再納入目前版本。既有提交歷史不會因此消失；若歷史中有不應公開的內容，請使用新的 GitHub 儲存庫。

## 部署前檢查

- GitHub Pages 只會收到 `web/dist`，不會發布 Python 原始碼、測試 PDF 或專案根目錄文件。
- `web/dist` 與 `node_modules` 已加入忽略清單；部署時由 GitHub Actions 重新建置，不要手動提交建置產物。
- Vite 使用相對資源路徑 `base: './'`，適用於 `https://<owner>.github.io/<repository>/` 這類專案頁面。
- 預覽只向瀏覽器要求 `Calibri` 與 `DFKai-SB`／標楷體等系統字型名稱，不會從網頁讀取 `C:\Windows\Fonts` 路徑。本機與 GitHub Pages 都使用同一種方式，並依訪客作業系統中安裝的字型顯示。
- 英數 FreeText 預設輸出 `/Calibri` 系統字型資源，與 PySide6 版相同，PDF 不嵌入 Calibri。若需讓 PDF 在沒有 Calibri 的電腦保持字型，請先將 `C:\Windows\Fonts\calibri.ttf` 複製到「下載」資料夾，再用「嵌入 Calibri」載入。
- 中文預覽預設使用系統標楷體；PDF 匯出含中文字或中文標點時需要嵌入字型。若缺少標楷體，請從 `C:\Windows\Fonts\` 將 `kaiu.ttf` 複製到「下載」資料夾，再按「嵌入標楷體」載入。
- 手動選取的字型只留在目前瀏覽器工作階段，並在匯出時嵌入 PDF；字型檔不會上傳到 GitHub。
- 不要把 Windows 字型檔複製到 Git 儲存庫或 `web/public`。字型授權與避免公開系統檔案都要求使用者從自己的電腦選取。
- PDF 透過瀏覽器檔案選取器在用戶端處理，不會被上傳到 GitHub Pages。
- GitHub Pages 網站可被公開瀏覽；推送前請確認預計發布的內容沒有私人資訊。

## 第一次部署

### 1. 建立 GitHub 儲存庫並設定 remote

目前這份本機 Git 儲存庫尚未設定 remote。先在 GitHub 建立一個空儲存庫，不要勾選自動建立 README、License 或 `.gitignore`，然後在專案根目錄 PowerShell 執行：

```powershell
git remote add origin https://github.com/<OWNER>/<REPOSITORY>.git
git push -u origin main
```

把 `<OWNER>` 與 `<REPOSITORY>` 換成你 GitHub 帳號／組織名稱和儲存庫名稱。如果之後 remote 已存在，只需執行 `git push`。

### 2. 將 Pages 發佈來源設為 GitHub Actions

在 GitHub 儲存庫開啟 **Settings → Pages**，在 **Build and deployment → Source** 選擇 **GitHub Actions**。本專案已提供 `.github/workflows/deploy.yml`，不需要再建立另一份部署工作流程。

### 3. 等待自動部署

推送到 `main` 後，打開 **Actions → Deploy PDF Editor to GitHub Pages** 查看建置與部署狀態。成功後可從該工作流程的 `github-pages` deployment 連結開啟網站。一般專案儲存庫網址格式為：

```text
https://<OWNER>.github.io/<REPOSITORY>/
```

如果儲存庫名稱是 `<OWNER>.github.io`，則網址通常是 `https://<OWNER>.github.io/`。

### 4. 後續更新網站

修改並在本機確認後，從專案根目錄執行：

```powershell
git add .
git commit -m "更新 PDF 編輯器"
git push origin main
```

每次推送 `main` 都會自動重新建置和部署。預覽直接依系統字型名稱選擇 Calibri 與標楷體；瀏覽器不能直接讀取 `C:\Windows\Fonts`。需要嵌入字型時，先將字型複製到「下載」資料夾，再使用頁面上的字型選取欄載入。

## 本機預覽部署產物

```powershell
cd web
pnpm install
pnpm build
pnpm preview
```

本機與 GitHub Pages 預覽都呼叫瀏覽器按系統字型名稱顯示字型。PDF 是否嵌入字型，依上述選取與系統字型資源方式處理。
