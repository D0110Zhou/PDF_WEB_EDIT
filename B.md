P0 重新规划（细化为 5 个子阶段）
P0-1：WebGL/WebGPU 矢量渲染引擎（核心）
目标：PDF 页面以矢量方式渲染到 GPU，6400% 缩放时表格线框和文字边缘保持锐利。

任务	技术方案	验收标准
PDF.js Operator List 解析	page.getOperatorList() → 解析 OPS.constructPath、OPS.showText 等指令	能正确提取路径坐标、填充/描边属性、变换矩阵
路径三角化	贝塞尔曲线 → 折线近似 → 三角面片（GPU 可渲染）	圆形/曲线在 6400% 下无明显多边形棱角
WebGPU 渲染后端	navigator.gpu → 创建管线 → 提交顶点/索引缓冲	Chrome/Edge 下正常渲染
WebGL 降级后端	检测 navigator.gpu 不存在时自动切换	Firefox/Safari 下正常渲染
Vector LOD	根据当前缩放级别动态调整曲线细分精度和线段数量	6400% 时帧率 ≥ 30fps
视口裁剪	只渲染当前可视区域内的几何体	放大时不会因全页几何体导致卡顿
WebGPU 浏览器支持现状：WebGPU 已在 Chrome 113 中首次发布，支持 Vulkan、Direct3D 12 和 macOS；Firefox 141 在 Windows 上发布，Safari 26 也已支持。Chrome、Edge、Firefox、Safari 四大主流浏览器均官方支持 WebGPU。

降级策略：优先尝试 WebGPU → 失败则 WebGL 2.0 → 再失败则 WebGL 1.0 + 扩展。

P0-2：矢量线检测取代像素级检测
目标：从 Operator List 中直接提取表格线段的矢量坐标，作为首选检测路径。

任务	技术方案	验收标准
矢量线段提取	从 constructPath 中筛选 line-to 指令，按角度分类水平/垂直	提取精度 100%（直接使用 PDF 原始坐标）
交点计算	水平线 × 垂直线 → 计算交点 → 构建网格	交点坐标误差 < 0.1pt
表格构建	相邻交点之间为一个 cell → 生成 cell 矩形数组	与 PyMuPDF find_tables 结果对比，准确率 ≥ 95%
用户框选过滤	仅保留 ROI 内的线段	与 Python 版 detect_cells_in_roi 逻辑一致
与 Python 版的差异：Python 版使用 page.find_tables() 做向量分析，JS 版直接从 Operator List 提取线段。两者都基于 PDF 矢量数据，理论上结果接近，但 JS 版需要自行实现“哪些线段构成表格边框”的判定逻辑。

P0-3：OpenCV.js 像素级检测（备选路径）
目标：当 P0-2 的矢量线提取无法覆盖某些复杂 PDF（如嵌入图片格式的表格、矢量线不规则的扫描件）时，自动降级到像素级检测。

任务	技术方案	验收标准
灰度化 + 高斯模糊	ctx.getImageData() + 可分离卷积	—
Sobel 边缘检测	3×3 卷积核	—
自适应二值化	局部均值/高斯加权	—
形态学线条提取	水平/垂直结构元素腐蚀	与 Python 版 TableDetector 逻辑一致
投影分析	Y 轴/X 轴投影 → 分割线定位	与 Python 版 y_cuts/x_cuts 算法一致
降级触发条件（自动判断，无需用户操作）：

P0-2 提取的矢量线段数量 < 4（无法构成表格）

P0-2 构建的 cell 数量为 0 或异常

用户手动指定“强制使用像素检测”

OpenCV.js 替代方案：若 WASM 被企业策略封锁，改用纯 JS 边缘检测（Sobel + 概率 Hough Transform）。性能会下降，但功能保留。

P0-4：排版引擎 + 字体度量
目标：前端复刻 Python 版 layout_cell 和 FontSet 的行为。

任务	技术方案	验收标准
字体加载	opentype.js 解析 Carlito-Regular.ttf（Calibri 度量兼容）和 NotoSansCJK（OFL 开源）	正确读取 advanceWidth、unitsPerEm
字型挑选	hasGlyph() 判断是否为 CJK → 自动切换备援字型	与 Python 版 FontSet.pick() 行为一致
逐字换行	复刻 wrap_text()：逐字累加宽度，超过 max_width 时换行，保留行首空白跳过逻辑	换行位置与 Python 版一致
垂直居中布局	复刻 layout_cell()：计算 baseline = top + i * line_h + (line_h - content_h) / 2 + asc * fs	文字位置与 Python 版一致
auto_fit	文字过多时自动缩小字号（每次 -0.5pt，直到 ≤ min_fs）	与 Python 版行为一致
字型度量一致性：opentype.js 的 advanceWidth / unitsPerEm * fontsize 与 fitz.Font.text_length 算法等价。使用 Carlito 替代 Calibri 可保证度量兼容。

P0-5：PDF 导出 + 专案管理
目标：将编辑后的内容写回 PDF，并提供专案 JSON 的存取。

任务	技术方案	验收标准
专案 JSON 存取	前端序列化 project_data → 下载 JSON；上传 JSON → 恢复状态	与 Python 版 JSON 格式完全兼容
normalize_style	复刻 Python 版：补齐缺漏栏位 + 范围限制	载入旧专案时行为一致
PDF 导出	pdf-lib 手动建构 FreeText annotation 字典（含 /DA、/DS、/Q、/DR）	在 Acrobat/Right PDF 中正常显示
字型资源挂载	pdf-lib 注册字体对象 → 挂载到 annotation 的 /DR 字典	字型正确显示（非 Helvetica）
原档保护	比对输出路径与原始路径，禁止覆写	与 Python 版逻辑一致
PDF 导出是方案 A 最脆弱的一环。pdf-lib 没有 add_freetext_annot 这种高阶 API，需要手动建构 PDF 对象字典。建议先用 pdf-lib 的 PDFTextField 或 drawText 做原型验证，再逐步完善 /DA、/DS 属性。

四、P0 验收标准
验收项	标准	测试方法
6400% 缩放清晰度	表格线框和文字边缘保持锐利，无像素化	载入含矢量表格的 PDF，缩放至 6400%，截图比对
交互流畅度	6400% 缩放下帧率 ≥ 30fps	Chrome DevTools Performance 面板
表格检测准确率	矢量路径 ≥ 95%，像素路径 ≥ 80%	与 Python 版结果对比
排版一致性	换行位置、文字水平/垂直居中与 Python 版一致	相同输入下逐行比对
PDF 导出可用性	导出的 PDF 在 Acrobat 中正常显示文字和字型	实际打开验证
专案 JSON 兼容性	可载入 Python 版产生的 JSON	交叉测试
GitHub Pages 部署	部署后功能正常，无 CORS/MIME 错误	实际部署验证


P0 之后的技术演进路径
P0 (当前)                    P1                         P2
─────────────────────────────────────────────────────────────
WebGL/WebGPU 渲染     →    字体轮廓 GPU 渲染     →    SDF 字体渲染
矢量线提取             →    SDF 加速的线检测      →    GPU 加速的表格识别
OpenCV.js 像素检测     →    纯 JS 边缘检测        →    WebGPU Compute Shader 边缘检测
pdf-lib 手动 annot    →    自建 /AP 外观串流     →    完整 PDF 编辑能力