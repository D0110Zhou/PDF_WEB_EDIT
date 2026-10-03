# GitHub Pages 部署與上線前檢查

本專案已加入 GitHub Actions 部署流程：推送到 `main` 後，GitHub 會安裝 Web 專案依賴、建置 `web/dist`，再將產物部署至 GitHub Pages。手動執行也可在 Actions 頁面選擇 `Deploy PDF Editor to GitHub Pages` 工作流程並按 Run workflow。

## 部署前檢查

- GitHub Pages 只會收到 `web/dist`，不會發布 Python 原始碼、測試 PDF 或專案根目錄文件。
- `web/dist` 與 `node_modules` 已加入忽略清單；部署時由 GitHub Actions 重新建置，不要手動提交建置產物。
- Vite 使用相對資源路徑 `base: './'`，適用於 `https://<owner>.github.io/<repository>/` 這類專案頁面。
- 本機 Vite 服務可讀取 Windows 系統字型 `C:\Windows\Fonts\calibri.ttf` 與 `C:\Windows\Fonts\kaiu.ttf`，用於預覽及嵌入 PDF。GitHub Pages 是靜態主機，不能讀取訪客電腦上的系統路徑；部署版預覽會依瀏覽器／作業系統的本機字型回退。
- 在 GitHub Pages 使用匯出功能時，請在頁面上選取字型檔：英數選 `C:\Windows\Fonts\calibri.ttf`，中文選 `C:\Windows\Fonts\kaiu.ttf`。所選字型只留在目前瀏覽器工作階段，並在匯出時嵌入 PDF；字型檔不會上傳到 GitHub。
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

每次推送 `main` 都會自動重新建置和部署。字型由 Windows 字型資料夾提供的 Vite 本機端點只在本機開發／預覽時使用；GitHub Pages 上請透過字型選取欄，從 `C:\Windows\Fonts` 選取 Calibri 與標楷體。

## 本機預覽部署產物

```powershell
cd web
pnpm install
pnpm build
pnpm preview
```

本機預覽會使用 Vite 的 Windows 字型端點。GitHub Actions 部署的靜態網站沒有這個端點，因此 Pages 使用者需自行選取字型以嵌入匯出 PDF。
