# 酒馆助手前端界面或脚本编写

@.cursor/rules/项目基本概念.mdc
@.cursor/rules/mcp.mdc
@.cursor/rules/酒馆变量.mdc
@.cursor/rules/酒馆助手接口.mdc
@.cursor/rules/前端界面.mdc
@.cursor/rules/脚本.mdc
@.cursor/rules/mvu变量框架.mdc
@.cursor/rules/mvu角色卡.mdc
<<<<<<< HEAD

---

## persona-collapse 项目注意事项

### 源码位置
- 源码在 `src/index.ts` 和 `src/manager.ts`（TypeScript）
- **不要直接编辑** `dist/index.js`（构建产物，会被覆盖）
- ST 导入路径使用 `sillytavern/xxx` 别名（如 `sillytavern/extensions`），已在 tsconfig.json 配置

### 常用命令
```powershell
pnpm build   # 编译 TypeScript → dist/index.js + dist/style.css
pnpm zip     # 打包为 persona-collapse-v{version}.zip（可直接部署到 ST）
pnpm watch   # 开发模式，文件变更自动重新编译
```

### 打包部署流程
1. `pnpm build` — 编译
2. `pnpm zip` — 生成 zip（输出到项目根目录）
3. 将 zip 解压到 `SillyTavern/public/scripts/extensions/third-party/persona-collapse/`
4. 刷新 SillyTavern 页面，在扩展列表中启用

### zip 包含文件
- `dist/index.js` — 插件主逻辑
- `dist/style.css` — 样式
- `manifest.json` — 插件元数据

### 版本号
在 `manifest.json` 的 `version` 字段修改，`pnpm zip` 会自动读取并命名 zip 文件。
=======
>>>>>>> c5efcd76bf56ff7466cc36a0a02eea9e070a25de
