window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-atlas',
  factory: function factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'workspace-atlas';
    const NS = 'workspaceAtlas';

    const dictionaries = {
      zh: {
        title: 'All-In-One Workspace',
        topology: '拓扑全景',
        repositories: '仓库列表',
        mounted: '已挂载',
        skipped: '按需未挂载',
        skippedShort: '未挂载',
        broken: '软链失效',
        refresh: '刷新工作区状态',
        inspector: '仓库详情',
        searchPlaceholder: '搜索仓库、职责或技术栈…',
        unlinked: '未关联工作区',
        linkAction: '关联项目',
        unlinkAction: '解除当前工作区关联',
        emptyTitle: '关联多仓工作区或代码仓库',
        emptySubtitle: '关联本地 Roma 工作区目录或 Git 仓库地址，自动生成架构拓扑全景与知识画像',
        tabDirectory: '本地工作区 / 目录',
        tabRemote: 'Git 仓库地址',
        dirPlaceholder: '/Users/.../本地工作区或项目目录路径',
        remotePlaceholder: 'ssh://git@icode.baidu.com:8235/<group>/<dept>/<repo>',
        pickDir: '浏览…',
        submitLink: '立即关联',
      },
      en: {
        title: 'All-In-One Workspace',
        topology: 'Topology',
        repositories: 'Repositories',
        mounted: 'Mounted',
        skipped: 'On-Demand',
        skippedShort: 'Unmounted',
        broken: 'Broken Link',
        refresh: 'Refresh Workspace',
        inspector: 'Repository Details',
        searchPlaceholder: 'Search repos, roles, stack…',
        unlinked: 'No Workspace Linked',
        linkAction: 'Link Project',
        unlinkAction: 'Unlink current workspace',
        emptyTitle: 'Link Workspace or Repository',
        emptySubtitle: 'Connect a local workspace directory or Git repository URL to generate the architecture atlas',
        tabDirectory: 'Local Directory',
        tabRemote: 'Git Remote URL',
        dirPlaceholder: '/Users/.../path-to-workspace-or-repo',
        remotePlaceholder: 'ssh://git@icode.baidu.com:8235/<group>/<dept>/<repo>',
        pickDir: 'Browse…',
        submitLink: 'Link Now',
      },
    };

    const DOMAIN_META = {
      hosts: {
        zhTitle: '客户端宿主',
        enTitle: 'CLIENT HOSTS',
        badge: '客户端宿主',
        tone: 'blue',
      },
      sdks: {
        zhTitle: '客户端 SDK',
        enTitle: 'CLIENT SDKS',
        badge: '客户端 SDK',
        tone: 'violet',
      },
      gateways: {
        zhTitle: 'API 网关',
        enTitle: 'API GATEWAYS',
        badge: 'API 网关',
        tone: 'teal',
      },
      services: {
        zhTitle: 'AI 与基础服务',
        enTitle: 'AI & INFRA SERVICES',
        badge: '基础服务',
        tone: 'indigo',
      },
    };

    const LENS_SHORT_LABELS = {
      all: '全部',
      mounted: '已挂载',
      aigc: 'AIGC / Rizz',
      monetization: '商业化',
      cloud: '云控与埋点',
      input: '输入与皮肤',
    };

    const DOC_TABS = [
      { id: 'overview', label: '概览' },
      { id: 'setup', label: '环境与构建' },
      { id: 'test', label: '测试门禁' },
      { id: 'capabilities', label: '契约配置' },
    ];

    const css = `
      .dsa-root {
        --dsa-bg: var(--dsw-alias-bg-base, #ffffff);
        --dsa-canvas-bg: color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 96.5%, var(--dsw-alias-label-primary, #0f172a));
        --dsa-card-bg: var(--dsw-alias-card-fill, var(--dsw-alias-bg-base, #ffffff));
        --dsa-subtle-bg: color-mix(in srgb, var(--dsw-alias-label-primary, #0f172a) 3.8%, var(--dsw-alias-bg-base, #ffffff));
        --dsa-lane-bg: color-mix(in srgb, var(--dsw-alias-label-primary, #0f172a) 2.6%, var(--dsw-alias-bg-base, #ffffff));
        --dsa-hover-bg: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary, #0f172a) 5.5%, transparent));

        --dsa-fg: var(--dsw-alias-label-primary, #0f172a);
        --dsa-muted: var(--dsw-alias-label-secondary, #64748b);
        --dsa-subtle: var(--dsw-alias-label-tertiary, #94a3b8);

        --dsa-border: var(--dsw-alias-border-l1, color-mix(in srgb, var(--dsa-fg) 7.5%, transparent));
        --dsa-border-strong: var(--dsw-alias-border-l2, color-mix(in srgb, var(--dsa-fg) 12%, transparent));
        --dsa-border-hover: var(--dsw-alias-border-l3, color-mix(in srgb, var(--dsa-fg) 20%, transparent));
        --dsa-grid-dot: color-mix(in srgb, var(--dsa-fg) 8%, transparent);

        --dsa-primary: var(--dsw-alias-state-business-primary, #2563eb);
        --dsa-primary-soft: color-mix(in srgb, var(--dsa-primary) 10%, var(--dsa-card-bg));
        --dsa-primary-border: color-mix(in srgb, var(--dsa-primary) 30%, transparent);

        --dsa-success: var(--dsw-alias-state-success-primary, #10b981);
        --dsa-success-soft: color-mix(in srgb, var(--dsa-success) 11%, var(--dsa-card-bg));
        --dsa-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
        --dsa-warn-soft: color-mix(in srgb, var(--dsa-warn) 12%, var(--dsa-card-bg));
        --dsa-danger: var(--dsw-alias-state-error-primary, #ef4444);

        --dsa-shadow-sm: var(--dsw-shadow-lv1, 0 1px 3px rgba(15, 23, 42, 0.05));
        --dsa-shadow-md: var(--dsw-shadow-lv2, 0 6px 18px -4px rgba(15, 23, 42, 0.1));
        --dsa-shadow-lg: var(--dsw-shadow-lv3, 0 16px 40px -8px rgba(15, 23, 42, 0.18));
        --dsa-ease: cubic-bezier(0.22, 1, 0.36, 1);

        color-scheme: light dark;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-height: 0;
        min-width: 0;
        background: var(--dsa-canvas-bg);
        color: var(--dsa-fg);
        font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        font-size: 13px;
        line-height: 1.5;
        overflow: hidden;
        position: relative;
        -webkit-font-smoothing: antialiased;
      }
      .dsa-root *, .dsa-root *::before, .dsa-root *::after {
        box-sizing: border-box;
      }

      /* =======================================================================
       * 1. TOP HEADER BAR (52px, Minimal & Balanced)
       * ===================================================================== */
      .dsa-header {
        height: 52px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 0 20px;
        border-bottom: 1px solid var(--dsa-border);
        background: var(--dsa-card-bg);
        z-index: 20;
      }
      .dsa-header-left,
      .dsa-header-center,
      .dsa-header-right {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .dsa-ws-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 30px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-subtle-bg);
        color: var(--dsa-fg);
        font-size: 12.5px;
        font-weight: 600;
      }
      .dsa-ws-select {
        background: transparent;
        border: 0;
        color: inherit;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        outline: none;
        padding-right: 2px;
      }
      .dsa-ws-select option {
        background: var(--dsa-card-bg);
        color: var(--dsa-fg);
      }
      .dsa-ws-stat {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        background: var(--dsa-subtle-bg);
        color: var(--dsa-muted);
        font-size: 11.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .dsa-ws-stat strong {
        color: var(--dsa-fg);
        font-weight: 600;
      }

      /* Segmented Switcher */
      .dsa-segmented {
        display: inline-flex;
        align-items: center;
        padding: 3px;
        border-radius: 9px;
        background: var(--dsa-subtle-bg);
        border: 1px solid var(--dsa-border);
        gap: 2px;
      }
      .dsa-seg-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 0;
        background: transparent;
        color: var(--dsa-muted);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        padding: 4px 12px;
        border-radius: 6px;
        cursor: pointer;
        transition: all 140ms var(--dsa-ease);
        white-space: nowrap;
      }
      .dsa-seg-btn:hover {
        color: var(--dsa-fg);
      }
      .dsa-seg-btn[data-active="true"] {
        background: var(--dsa-card-bg);
        color: var(--dsa-fg);
        font-weight: 600;
        box-shadow: var(--dsa-shadow-sm);
      }
      .dsa-seg-count {
        font-size: 11px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--dsa-subtle-bg);
        color: var(--dsa-muted);
        font-variant-numeric: tabular-nums;
      }

      /* Buttons */
      .dsa-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        height: 30px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-card-bg);
        color: var(--dsa-fg);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 140ms var(--dsa-ease);
        white-space: nowrap;
      }
      .dsa-btn:hover:enabled {
        background: var(--dsa-hover-bg);
        border-color: var(--dsa-border-hover);
      }
      .dsa-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .dsa-icon-btn {
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 8px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dsa-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 140ms var(--dsa-ease);
        flex-shrink: 0;
      }
      .dsa-icon-btn:hover:enabled {
        background: var(--dsa-hover-bg);
        color: var(--dsa-fg);
      }
      .dsa-icon-btn[data-danger="true"]:hover:enabled {
        color: var(--dsa-danger);
        background: color-mix(in srgb, var(--dsa-danger) 10%, transparent);
      }

      /* =======================================================================
       * 2. UNIFIED FILTER & SEARCH SUB-BAR
       * ===================================================================== */
      .dsa-subbar {
        height: 44px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 0 20px;
        border-bottom: 1px solid var(--dsa-border);
        background: color-mix(in srgb, var(--dsa-card-bg) 75%, var(--dsa-canvas-bg));
        backdrop-filter: blur(8px);
        z-index: 15;
      }
      .dsa-lens-group {
        display: flex;
        align-items: center;
        gap: 4px;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .dsa-lens-group::-webkit-scrollbar {
        display: none;
      }
      .dsa-lens-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dsa-muted);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        height: 26px;
        padding: 0 10px;
        border-radius: 999px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 130ms var(--dsa-ease);
      }
      .dsa-lens-btn:hover {
        color: var(--dsa-fg);
        background: var(--dsa-hover-bg);
      }
      .dsa-lens-btn[data-active="true"] {
        background: var(--dsa-primary-soft);
        border-color: var(--dsa-primary-border);
        color: var(--dsa-primary);
        font-weight: 600;
      }
      .dsa-search-box {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 0 10px;
        height: 28px;
        width: 220px;
        border-radius: 7px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-card-bg);
        transition: border-color 140ms var(--dsa-ease), width 160ms var(--dsa-ease), box-shadow 140ms var(--dsa-ease);
        flex-shrink: 0;
      }
      .dsa-search-box:focus-within {
        width: 260px;
        border-color: var(--dsa-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsa-primary) 16%, transparent);
      }
      .dsa-search-input {
        border: 0;
        background: transparent;
        color: var(--dsa-fg);
        font: inherit;
        font-size: 12px;
        width: 100%;
        outline: none;
      }
      .dsa-search-input::placeholder {
        color: var(--dsa-subtle);
      }

      /* =======================================================================
       * 3. MAIN WORKSPACE STAGE & TOPOLOGY LANES
       * ===================================================================== */
      .dsa-body {
        flex: 1;
        display: flex;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        position: relative;
      }
      .dsa-stage {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        position: relative;
      }

      /* Topology Canvas */
      .dsa-canvas-scroll {
        flex: 1;
        overflow: auto;
        position: relative;
        background-image: radial-gradient(var(--dsa-grid-dot) 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .dsa-canvas-inner {
        position: relative;
        min-width: 780px;
        max-width: 1360px;
        min-height: 100%;
        margin: 0 auto;
        padding: 22px 24px 40px;
      }
      .dsa-edge-svg {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 1;
      }
      @keyframes dsaEdgeFlow {
        to { stroke-dashoffset: -20; }
      }
      .dsa-edge-anim {
        stroke-dasharray: 5 5;
        animation: dsaEdgeFlow 1.1s linear infinite;
      }
      .dsa-columns {
        position: relative;
        z-index: 2;
        display: grid;
        grid-template-columns: repeat(4, minmax(175px, 1fr));
        gap: 18px;
        align-items: start;
      }
      .dsa-col {
        display: flex;
        flex-direction: column;
        gap: 9px;
        padding: 10px;
        border-radius: 13px;
        background: color-mix(in srgb, var(--dsa-lane-bg) 82%, transparent);
        border: 1px solid var(--dsa-border);
      }
      .dsa-col-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 4px 4px;
        gap: 8px;
      }
      .dsa-col-title-wrap {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      .dsa-col-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .dsa-col-dot[data-tone="blue"] { background: #3b82f6; }
      .dsa-col-dot[data-tone="violet"] { background: #8b5cf6; }
      .dsa-col-dot[data-tone="teal"] { background: #14b8a6; }
      .dsa-col-dot[data-tone="indigo"] { background: #6366f1; }

      .dsa-col-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--dsa-fg);
        white-space: nowrap;
      }
      .dsa-col-count {
        font-size: 11px;
        font-weight: 500;
        color: var(--dsa-muted);
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--dsa-subtle-bg);
        font-variant-numeric: tabular-nums;
      }

      /* Repository Node Card (Clean 2-Line Structure) */
      .dsa-node {
        position: relative;
        border-radius: 10px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-card-bg);
        padding: 10px 12px;
        cursor: pointer;
        box-shadow: var(--dsa-shadow-sm);
        transition: opacity 150ms var(--dsa-ease), transform 140ms var(--dsa-ease), border-color 140ms var(--dsa-ease), box-shadow 140ms var(--dsa-ease);
      }
      .dsa-node[data-mounted="true"] {
        border-left: 3px solid var(--dsa-success);
      }
      .dsa-node[data-mounted="false"] {
        background: color-mix(in srgb, var(--dsa-card-bg) 75%, var(--dsa-canvas-bg));
        border-color: var(--dsa-border);
        box-shadow: none;
      }
      .dsa-node:hover {
        border-color: var(--dsa-border-hover);
        box-shadow: var(--dsa-shadow-md);
        transform: translateY(-1px);
      }
      .dsa-node[data-focused="true"] {
        border-color: var(--dsa-primary);
        box-shadow: 0 0 0 1px var(--dsa-primary), var(--dsa-shadow-md);
      }
      .dsa-node[data-faded="true"] {
        opacity: 0.25;
      }
      .dsa-node-row1 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        min-width: 0;
      }
      .dsa-node-title-group {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }
      .dsa-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        flex-shrink: 0;
      }
      .dsa-dot[data-state="mounted"] {
        background: var(--dsa-success);
      }
      .dsa-dot[data-state="skipped"] {
        border: 1.5px solid var(--dsa-subtle);
        background: transparent;
      }
      .dsa-dot[data-state="broken"] {
        background: var(--dsa-danger);
      }
      .dsa-node-name {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsa-fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsa-node[data-mounted="false"] .dsa-node-name {
        color: color-mix(in srgb, var(--dsa-fg) 82%, var(--dsa-muted));
        font-weight: 500;
      }
      .dsa-tech-tag {
        flex-shrink: 0;
        font-size: 10.5px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 5px;
        background: var(--dsa-subtle-bg);
        color: var(--dsa-muted);
        white-space: nowrap;
      }
      .dsa-node-summary {
        margin-top: 4px;
        font-size: 11.5px;
        color: var(--dsa-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsa-node-meta {
        margin-top: 7px;
        padding-top: 6px;
        border-top: 1px solid var(--dsa-border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 11px;
        color: var(--dsa-muted);
        white-space: nowrap;
      }
      .dsa-mono {
        font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
      }

      /* =======================================================================
       * 4. REPOSITORY MATRIX TABLE VIEW (Zero Multi-Line Wrapping)
       * ===================================================================== */
      .dsa-matrix-wrap {
        flex: 1;
        overflow: auto;
        padding: 20px 24px 36px;
      }
      .dsa-matrix-inner {
        max-width: 1180px;
        margin: 0 auto;
      }
      .dsa-table-card {
        border: 1px solid var(--dsa-border-strong);
        border-radius: 12px;
        background: var(--dsa-card-bg);
        box-shadow: var(--dsa-shadow-sm);
        overflow: hidden;
      }
      .dsa-table {
        width: 100%;
        table-layout: fixed;
        border-collapse: collapse;
        font-size: 12.5px;
      }
      .dsa-table th {
        text-align: left;
        padding: 11px 16px;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--dsa-muted);
        border-bottom: 1px solid var(--dsa-border-strong);
        background: var(--dsa-subtle-bg);
        white-space: nowrap;
      }
      .dsa-table td {
        padding: 11px 16px;
        border-bottom: 1px solid var(--dsa-border);
        vertical-align: middle;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dsa-table tr:last-child td {
        border-bottom: 0;
      }
      .dsa-table tbody tr {
        cursor: pointer;
        transition: background-color 120ms ease;
      }
      .dsa-table tbody tr:hover {
        background: var(--dsa-hover-bg);
      }
      .dsa-table tbody tr[data-focused="true"] {
        background: var(--dsa-primary-soft);
      }
      .dsa-repo-cell {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .dsa-repo-cell-top {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .dsa-repo-cell-name {
        font-weight: 600;
        font-size: 13px;
        color: var(--dsa-fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsa-repo-cell-sub {
        font-size: 11.5px;
        color: var(--dsa-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding-left: 15px;
      }

      /* Domain & Status Pills */
      .dsa-domain-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 500;
        white-space: nowrap;
        background: var(--dsa-subtle-bg);
        color: var(--dsa-muted);
      }
      .dsa-domain-pill[data-tone="blue"] {
        background: color-mix(in srgb, #3b82f6 11%, transparent);
        color: #3b82f6;
      }
      .dsa-domain-pill[data-tone="violet"] {
        background: color-mix(in srgb, #8b5cf6 11%, transparent);
        color: #8b5cf6;
      }
      .dsa-domain-pill[data-tone="teal"] {
        background: color-mix(in srgb, #14b8a6 11%, transparent);
        color: #0d9488;
      }
      .dsa-domain-pill[data-tone="indigo"] {
        background: color-mix(in srgb, #6366f1 11%, transparent);
        color: #6366f1;
      }

      .dsa-status-cell {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
      }
      .dsa-status-group {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        overflow: hidden;
      }
      .dsa-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 500;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .dsa-status-pill[data-mounted="true"] {
        background: var(--dsa-success-soft);
        color: var(--dsa-success);
      }
      .dsa-status-pill[data-mounted="false"] {
        background: var(--dsa-subtle-bg);
        color: var(--dsa-muted);
      }
      .dsa-branch-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--dsa-muted);
        background: var(--dsa-subtle-bg);
        padding: 1px 7px;
        border-radius: 5px;
        max-width: 115px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsa-dirty-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--dsa-warn);
        flex-shrink: 0;
      }
      .dsa-row-arrow {
        color: var(--dsa-subtle);
        font-size: 14px;
        opacity: 0;
        transition: opacity 120ms ease, transform 120ms ease;
        flex-shrink: 0;
      }
      .dsa-table tbody tr:hover .dsa-row-arrow,
      .dsa-table tbody tr[data-focused="true"] .dsa-row-arrow {
        opacity: 1;
        transform: translateX(2px);
      }

      /* =======================================================================
       * 5. FLOATING SLIDE-OVER INSPECTOR DRAWER (Does Not Crush Main Stage!)
       * ===================================================================== */
      .dsa-drawer {
        position: absolute;
        top: 12px;
        right: 14px;
        bottom: 12px;
        width: 384px;
        max-width: calc(100% - 28px);
        border-radius: 14px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-card-bg);
        box-shadow: var(--dsa-shadow-lg);
        display: flex;
        flex-direction: column;
        min-height: 0;
        z-index: 30;
        overflow: hidden;
        animation: dsaDrawerIn 160ms var(--dsa-ease);
      }
      @keyframes dsaDrawerIn {
        from {
          opacity: 0;
          transform: translateX(12px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      .dsa-drawer-hero {
        padding: 16px 16px 14px;
        border-bottom: 1px solid var(--dsa-border);
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex-shrink: 0;
        background: color-mix(in srgb, var(--dsa-subtle-bg) 45%, var(--dsa-card-bg));
      }
      .dsa-drawer-toprow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .dsa-drawer-name-group {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .dsa-drawer-repo-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--dsa-fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsa-drawer-path {
        font-size: 11px;
        color: var(--dsa-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsa-drawer-desc {
        margin: 0;
        font-size: 12px;
        color: var(--dsa-muted);
        line-height: 1.55;
      }
      .dsa-drawer-pills {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding-top: 2px;
      }
      .dsa-drawer-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        border-bottom: 1px solid var(--dsa-border);
        background: var(--dsa-card-bg);
        padding: 0 16px;
        gap: 16px;
        flex-shrink: 0;
      }
      .dsa-drawer-tab {
        border: 0;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--dsa-muted);
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        height: 38px;
        cursor: pointer;
        transition: color 130ms ease, border-color 130ms ease;
      }
      .dsa-drawer-tab:hover {
        color: var(--dsa-fg);
      }
      .dsa-drawer-tab[data-active="true"] {
        color: var(--dsa-primary);
        border-bottom-color: var(--dsa-primary);
      }

      .dsa-drawer-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .dsa-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .dsa-section-label {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--dsa-fg);
      }
      .dsa-section-count {
        font-size: 11px;
        color: var(--dsa-muted);
      }

      .dsa-rel-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dsa-rel-item {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 9px 11px;
        border-radius: 9px;
        border: 1px solid var(--dsa-border);
        background: var(--dsa-subtle-bg);
        cursor: pointer;
        transition: border-color 120ms ease, background-color 120ms ease;
      }
      .dsa-rel-item:hover {
        border-color: var(--dsa-primary-border);
        background: var(--dsa-hover-bg);
      }
      .dsa-cmd-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 11px;
        border-radius: 9px;
        border: 1px solid var(--dsa-border);
        background: var(--dsa-subtle-bg);
      }
      .dsa-copy-btn {
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-card-bg);
        color: var(--dsa-muted);
        font: inherit;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 6px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .dsa-copy-btn:hover {
        color: var(--dsa-fg);
        border-color: var(--dsa-border-hover);
      }

      /* Formatted Markdown Reader in Drawer */
      .dsa-md-card {
        border-radius: 10px;
        border: 1px solid var(--dsa-border);
        background: var(--dsa-subtle-bg);
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 12px;
        line-height: 1.6;
        color: var(--dsa-fg);
      }
      .dsa-md-h2 {
        margin: 4px 0 0;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsa-fg);
      }
      .dsa-md-p {
        margin: 0;
        color: var(--dsa-muted);
      }
      .dsa-md-ul {
        margin: 0;
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        color: var(--dsa-muted);
      }
      .dsa-md-code {
        font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--dsa-card-bg);
        border: 1px solid var(--dsa-border);
        color: var(--dsa-fg);
      }
      .dsa-md-pre {
        margin: 2px 0;
        padding: 9px 11px;
        border-radius: 7px;
        background: var(--dsa-card-bg);
        border: 1px solid var(--dsa-border);
        font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px;
        line-height: 1.55;
        color: var(--dsa-muted);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* =======================================================================
       * 6. EMPTY STATE ONBOARDING & LINK MODAL
       * ===================================================================== */
      .dsa-onboarding-wrap {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px;
        background-image: radial-gradient(var(--dsa-grid-dot) 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .dsa-onboarding-card {
        width: 100%;
        max-width: 440px;
        border-radius: 14px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-card-bg);
        padding: 26px 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        box-shadow: var(--dsa-shadow-lg);
      }
      .dsa-onboarding-head {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 6px;
      }
      .dsa-onboarding-icon {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        border: 1px solid var(--dsa-primary-border);
        background: var(--dsa-primary-soft);
        color: var(--dsa-primary);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 4px;
      }
      .dsa-onboarding-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--dsa-fg);
        margin: 0;
      }
      .dsa-onboarding-sub {
        font-size: 12px;
        color: var(--dsa-muted);
        margin: 0;
      }
      .dsa-onboarding-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        padding: 3px;
        border-radius: 9px;
        background: var(--dsa-subtle-bg);
        border: 1px solid var(--dsa-border);
        gap: 3px;
      }
      .dsa-onboarding-tab {
        border: 0;
        background: transparent;
        color: var(--dsa-muted);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        padding: 6px 10px;
        border-radius: 7px;
        cursor: pointer;
        transition: all 140ms var(--dsa-ease);
      }
      .dsa-onboarding-tab:hover {
        color: var(--dsa-fg);
      }
      .dsa-onboarding-tab[data-active="true"] {
        background: var(--dsa-card-bg);
        color: var(--dsa-fg);
        font-weight: 600;
        box-shadow: var(--dsa-shadow-sm);
      }
      .dsa-input {
        width: 100%;
        height: 36px;
        padding: 0 12px;
        border-radius: 9px;
        border: 1px solid var(--dsa-border-strong);
        background: var(--dsa-subtle-bg);
        color: var(--dsa-fg);
        font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12px;
        outline: none;
        transition: border-color 140ms var(--dsa-ease), box-shadow 140ms var(--dsa-ease);
      }
      .dsa-input::placeholder {
        color: var(--dsa-subtle);
      }
      .dsa-input:focus {
        background: var(--dsa-card-bg);
        border-color: var(--dsa-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsa-primary) 18%, transparent);
      }
      .dsa-btn-primary {
        width: 100%;
        height: 36px;
        border-radius: 9px;
        border: 0;
        background: var(--dsa-primary);
        color: #ffffff;
        font: inherit;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 140ms var(--dsa-ease);
      }
      .dsa-btn-primary:hover:enabled {
        opacity: 0.92;
      }
      .dsa-btn-primary:disabled {
        background: var(--dsa-subtle-bg);
        color: var(--dsa-subtle);
        cursor: not-allowed;
      }
      .dsa-modal-backdrop {
        position: absolute;
        inset: 0;
        z-index: 40;
        background: rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
    `;

    function SidebarAtlasIcon({ size = 16 }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.65,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M7.75 5.375H16.25M7.75 18.625H16.25M5.375 7.75V16.25M18.625 7.75V16.25',
          strokeOpacity: 0.55,
        }),
        h('rect', { x: 3, y: 3, width: 4.75, height: 4.75, rx: 1.35 }),
        h('rect', { x: 16.25, y: 3, width: 4.75, height: 4.75, rx: 1.35 }),
        h('rect', { x: 3, y: 16.25, width: 4.75, height: 4.75, rx: 1.35 }),
        h('rect', { x: 16.25, y: 16.25, width: 4.75, height: 4.75, rx: 1.35 }),
        h('rect', {
          x: 9.4,
          y: 9.4,
          width: 5.2,
          height: 5.2,
          rx: 1.2,
          transform: 'rotate(45 12 12)',
          fill: 'currentColor',
          fillOpacity: 0.18,
        })
      );
    }

    function IconRefresh() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.4-3.65' }),
        h('path', { d: 'M13.5 2.5v2.25h-2.25' })
      );
    }

    function IconUnlink() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M6.5 9.5 4.8 11.2a2.12 2.12 0 0 1-3-3L3.5 6.5' }),
        h('path', { d: 'm9.5 6.5 1.7-1.7a2.12 2.12 0 0 1 3 3L12.5 9.5' }),
        h('path', { d: 'm3 3 10 10' })
      );
    }

    function IconSearch() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', style: { color: 'var(--dsa-subtle)', flexShrink: 0 } },
        h('circle', { cx: 7, cy: 7, r: 4.5 }),
        h('path', { d: 'm10.5 10.5 3 3' })
      );
    }

    function getConnectedRepoSet(edges, repoId) {
      if (!repoId) return null;
      const set = new Set([repoId]);
      for (const e of edges || []) {
        if (e.from === repoId) set.add(e.to);
        if (e.to === repoId) set.add(e.from);
      }
      return set;
    }

    /**
     * Extract a concise 1-word/short tech pill for Topology Node Cards.
     */
    function formatNodeTechTag(stack = '') {
      const s = String(stack || '');
      if (/kotlin/i.test(s)) return 'Kotlin';
      if (/swift|objective-c|objc/i.test(s)) return 'Swift / ObjC';
      if (/go\b/i.test(s)) return 'Go';
      if (/python/i.test(s)) return 'Python';
      if (/php/i.test(s)) return 'PHP';
      if (/c\+\+|jni/i.test(s)) return 'C++ / JNI';
      if (/jdk|android|sdk/i.test(s)) return 'Android SDK';
      return s.split('·')[0].trim().slice(0, 12) || 'Repo';
    }

    /**
     * Clean verbose version range syntax (`JDK >=1.8 <=11` -> `JDK 8–11`, `Go >=1.18` -> `Go 1.18+`).
     */
    function formatCleanStack(stack = '') {
      return String(stack || '')
        .replace(/>=\s*1\.8\s*<=\s*11/g, '8–11')
        .replace(/>=\s*([0-9.]+)/g, '$1+')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /**
     * Strip raw markdown backticks and overly verbose parenthetical paths from summaries.
     */
    function cleanSummaryText(summary = '') {
      return String(summary || '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/（`[^`]+`\s*\/\s*`[^`]+`）/g, '')
        .replace(/\([^)]*\/[^)]*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /**
     * Format relation kind into clean Chinese label.
     */
    function formatRelationKind(kind = '') {
      if (kind === 'protocol-contract') return '接口契约';
      if (kind === 'consumer') return '组件依赖';
      if (kind === 'same-domain') return '同域协同';
      return kind || '关联契约';
    }

    /**
     * Render inline markdown code spans (`foo`) cleanly without raw backticks.
     */
    function renderInlineFormatted(text) {
      const parts = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
      return parts.map((part, idx) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return h('code', { key: idx, className: 'dsa-md-code' }, part.slice(1, -1));
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return h('strong', { key: idx, style: { color: 'var(--dsa-fg)', fontWeight: 600 } }, part.slice(2, -2));
        }
        return part;
      });
    }

    /**
     * Lightweight structured Markdown renderer that strips machine verification boilerplate
     * (`> **verified**: ...`) and redundant `# repo/path Overview` headers.
     */
    function renderStructuredDoc(mdText) {
      if (!mdText) return null;
      const lines = String(mdText).split(/\r?\n/);
      const blocks = [];
      let listItems = [];
      let inCodeBlock = false;
      let codeLines = [];

      const flushList = () => {
        if (listItems.length > 0) {
          blocks.push(
            h(
              'ul',
              { key: `ul-${blocks.length}`, className: 'dsa-md-ul' },
              ...listItems.map((item, i) => h('li', { key: i }, renderInlineFormatted(item)))
            )
          );
          listItems = [];
        }
      };

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
          flushList();
          if (inCodeBlock) {
            blocks.push(
              h('pre', { key: `pre-${blocks.length}`, className: 'dsa-md-pre' }, codeLines.join('\n'))
            );
            codeLines = [];
            inCodeBlock = false;
          } else {
            inCodeBlock = true;
          }
          continue;
        }

        if (inCodeBlock) {
          codeLines.push(line);
          continue;
        }

        if (!trimmed) {
          flushList();
          continue;
        }

        // Skip top H1 (`# baidu/... Overview`) and noisy machine verification blockquotes (`> **verified**: ...`)
        if (/^#\s+/.test(trimmed)) continue;
        if (/^>\s*\*\*verified\*\*/i.test(trimmed)) continue;

        if (/^#{2,4}\s+/.test(trimmed)) {
          flushList();
          const headingText = trimmed.replace(/^#{2,4}\s+/, '');
          blocks.push(h('div', { key: `h-${blocks.length}`, className: 'dsa-md-h2' }, headingText));
          continue;
        }

        const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
        if (bulletMatch) {
          listItems.push(bulletMatch[1]);
          continue;
        }

        flushList();
        blocks.push(
          h('p', { key: `p-${blocks.length}`, className: 'dsa-md-p' }, renderInlineFormatted(trimmed))
        );
      }

      flushList();
      if (codeLines.length > 0) {
        blocks.push(h('pre', { key: `pre-end`, className: 'dsa-md-pre' }, codeLines.join('\n')));
      }

      if (blocks.length === 0) {
        return h('pre', { className: 'dsa-md-pre' }, mdText);
      }
      return h('div', { className: 'dsa-md-card' }, ...blocks);
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh: dictionaries.zh, en: dictionaries.en });
          } catch {
            return () => {};
          }
        });

        const t = key => {
          try {
            const bound = ctx.locale.bind(NS);
            return bound(key);
          } catch {
            return dictionaries.zh[key] || key;
          }
        };

        function AtlasMainPage() {
          React.useSyncExternalStore(
            fn => ctx.locale.subscribe(fn),
            () => ctx.locale.getSnapshot(),
            () => ctx.locale.getSnapshot()
          );

          const [snapshot, setSnapshot] = React.useState(null);
          const [loading, setLoading] = React.useState(true);
          const [error, setError] = React.useState(null);
          const [workspacePath, setWorkspacePath] = React.useState('');

          const [viewMode, setViewMode] = React.useState('topology'); // 'topology' | 'repos'
          const [lens, setLens] = React.useState('all');
          const [searchQuery, setSearchQuery] = React.useState('');

          // Start unobstructed (drawer closed, no forced focus dimming)
          const [focusRepoId, setFocusRepoId] = React.useState(null);
          const [hoverRepoId, setHoverRepoId] = React.useState(null);
          const [drawerOpen, setDrawerOpen] = React.useState(false);
          const [drawerSection, setDrawerSection] = React.useState('relations'); // 'relations' | 'docs'
          const [docTab, setDocTab] = React.useState('overview');
          const [copiedCmd, setCopiedCmd] = React.useState(null);

          const [svgPaths, setSvgPaths] = React.useState([]);
          const [svgSize, setSvgSize] = React.useState({ w: 960, h: 640 });

          // Onboarding & user link state
          const [linkMode, setLinkMode] = React.useState('directory');
          const [linkInput, setLinkInput] = React.useState('');
          const [linkSubmitting, setLinkSubmitting] = React.useState(false);
          const [pickingDir, setPickingDir] = React.useState(false);
          const [linkError, setLinkError] = React.useState(null);
          const [showLinkModal, setShowLinkModal] = React.useState(false);

          const stageInnerRef = React.useRef(null);
          const nodeRefs = React.useRef(new Map());

          const handlePickDirectory = async () => {
            setPickingDir(true);
            setLinkError(null);
            try {
              const res = await fetch('/api/workspace-atlas', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                  action: 'pickDirectory',
                  defaultPath: linkInput.trim() || undefined,
                }),
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data?.error || '无法打开目录选择器');
              }
              if (!data.canceled && data.path) {
                setLinkInput(data.path);
              }
            } catch (err) {
              setLinkError(err instanceof Error ? err.message : '无法打开目录选择器');
            } finally {
              setPickingDir(false);
            }
          };

          const applySnapshotData = React.useCallback((data, fallbackPath = '') => {
            setSnapshot(data);
            if (data?.linked && data.workspace?.path) {
              setWorkspacePath(data.workspace.path);
            } else if (!data?.linked) {
              setWorkspacePath('');
              setDrawerOpen(false);
              setFocusRepoId(null);
            } else if (fallbackPath) {
              setWorkspacePath(fallbackPath);
            }
          }, []);

          const loadSnapshot = React.useCallback(async (targetPath, forceRefresh = false) => {
            setLoading(true);
            setError(null);
            try {
              const url = new URL('/api/workspace-atlas', window.location.origin);
              if (targetPath) url.searchParams.set('workspacePath', targetPath);
              if (forceRefresh) url.searchParams.set('refresh', '1');
              const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const data = await res.json();
              applySnapshotData(data, targetPath);
            } catch (err) {
              setError(err instanceof Error ? err.message : '加载失败');
            } finally {
              setLoading(false);
            }
          }, [applySnapshotData]);

          React.useEffect(() => {
            loadSnapshot(workspacePath, false);
          }, [workspacePath]);

          const closeInspector = React.useCallback(() => {
            setDrawerOpen(false);
            setFocusRepoId(null);
          }, []);

          React.useEffect(() => {
            const onKeyDown = e => {
              if (e.key === 'Escape') {
                if (showLinkModal) setShowLinkModal(false);
                else if (drawerOpen) closeInspector();
              }
            };
            window.addEventListener('keydown', onKeyDown);
            return () => window.removeEventListener('keydown', onKeyDown);
          }, [showLinkModal, drawerOpen, closeInspector]);

          const handleLinkSubmit = async (e, appendToCurrent = false) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            const val = linkInput.trim();
            if (!val) return;
            setLinkSubmitting(true);
            setLinkError(null);
            try {
              const payload =
                linkMode === 'directory'
                  ? { action: 'linkDirectory', path: val, appendToCurrent }
                  : { action: 'linkRemote', remoteUrl: val };
              const res = await fetch('/api/workspace-atlas', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data?.error || '关联失败');
              }
              applySnapshotData(data);
              setLinkInput('');
              setShowLinkModal(false);
            } catch (err) {
              setLinkError(err instanceof Error ? err.message : '关联失败');
            } finally {
              setLinkSubmitting(false);
            }
          };

          const handleUnlinkWorkspace = async () => {
            const target = workspacePath || snapshot?.workspace?.path;
            if (!target) return;
            setLoading(true);
            try {
              const res = await fetch('/api/workspace-atlas', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'unlinkWorkspace', workspacePath: target }),
              });
              const data = await res.json();
              if (res.ok) {
                applySnapshotData(data);
              }
            } finally {
              setLoading(false);
            }
          };

          const handleSelectWorkspace = async nextPath => {
            setWorkspacePath(nextPath);
            try {
              const res = await fetch('/api/workspace-atlas', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'selectWorkspace', workspacePath: nextPath }),
              });
              const data = await res.json();
              if (res.ok) {
                applySnapshotData(data, nextPath);
              }
            } catch {
              // fallback
            }
          };

          const activeTarget = hoverRepoId || (drawerOpen ? focusRepoId : null);

          // Compute SVG cubic Bezier edges on layout changes
          const recomputeEdges = React.useCallback(() => {
            const stageEl = stageInnerRef.current;
            if (!stageEl || !snapshot || viewMode !== 'topology') return;

            const stageRect = stageEl.getBoundingClientRect();
            const width = Math.max(stageEl.scrollWidth, stageRect.width);
            const height = Math.max(stageEl.scrollHeight, stageRect.height);
            setSvgSize({ w: width, h: height });

            const computed = [];

            for (const edge of snapshot.edges || []) {
              const elFrom = nodeRefs.current.get(edge.from);
              const elTo = nodeRefs.current.get(edge.to);
              if (!elFrom || !elTo) continue;

              const r1 = elFrom.getBoundingClientRect();
              const r2 = elTo.getBoundingClientRect();
              if (r1.width === 0 || r2.width === 0) continue;

              const isHighlighted = activeTarget
                ? edge.from === activeTarget || edge.to === activeTarget
                : false;
              const sameCol = Math.abs(r1.left - r2.left) < 36;

              let d = '';
              if (sameCol) {
                const x = r1.right - stageRect.left;
                const y1 = r1.top + r1.height / 2 - stageRect.top;
                const y2 = r2.top + r2.height / 2 - stageRect.top;
                d = `M ${x} ${y1} C ${x + 22} ${y1}, ${x + 22} ${y2}, ${x} ${y2}`;
              } else {
                const leftToRight = r1.left < r2.left;
                const x1 = (leftToRight ? r1.right : r1.left) - stageRect.left;
                const y1 = r1.top + r1.height / 2 - stageRect.top;
                const x2 = (leftToRight ? r2.left : r2.right) - stageRect.left;
                const y2 = r2.top + r2.height / 2 - stageRect.top;
                const dx = Math.max(28, Math.abs(x2 - x1) * 0.45) * (leftToRight ? 1 : -1);
                d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
              }

              const stroke = isHighlighted
                ? edge.jointRegression
                  ? '#f59e0b'
                  : edge.kind === 'protocol-contract'
                  ? '#8b5cf6'
                  : '#2563eb'
                : 'var(--dsa-border-strong)';

              computed.push({
                id: edge.id,
                d,
                stroke,
                strokeWidth: isHighlighted ? 1.85 : 1,
                strokeOpacity: isHighlighted ? 0.92 : activeTarget ? 0.18 : 0.45,
                dash: edge.kind === 'protocol-contract' && !isHighlighted ? '4 4' : undefined,
                animated: isHighlighted,
              });
            }

            setSvgPaths(computed);
          }, [snapshot, viewMode, activeTarget]);

          React.useEffect(() => {
            const raf = requestAnimationFrame(recomputeEdges);
            const onResize = () => requestAnimationFrame(recomputeEdges);
            window.addEventListener('resize', onResize);
            return () => {
              cancelAnimationFrame(raf);
              window.removeEventListener('resize', onResize);
            };
          }, [recomputeEdges]);

          const inspectRepo = (id, e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            if (drawerOpen && focusRepoId === id) {
              closeInspector();
            } else {
              setFocusRepoId(id);
              setDrawerOpen(true);
            }
          };

          const handleCopyCommand = (cmdName, cmdRun) => {
            try {
              navigator.clipboard?.writeText(cmdRun);
              setCopiedCmd(cmdName);
              setTimeout(() => setCopiedCmd(prev => (prev === cmdName ? null : prev)), 1500);
            } catch {
              // ignore
            }
          };

          const connectedSet = React.useMemo(
            () => (snapshot && activeTarget ? getConnectedRepoSet(snapshot.edges, activeTarget) : null),
            [snapshot, activeTarget]
          );

          const matchesFilter = repo => {
            if (lens === 'mounted' && !repo.mounted) return false;
            if (lens !== 'all' && lens !== 'mounted' && !(repo.lenses || []).includes(lens)) {
              return false;
            }
            const q = searchQuery.trim().toLowerCase();
            if (!q) return true;
            return (
              repo.id.toLowerCase().includes(q) ||
              repo.path.toLowerCase().includes(q) ||
              repo.stack.toLowerCase().includes(q) ||
              repo.summary.toLowerCase().includes(q)
            );
          };

          const focusedRepo =
            (focusRepoId && snapshot?.repos?.find(r => r.id === focusRepoId)) || null;
          const isLinked = Boolean(snapshot?.linked && snapshot?.workspace && snapshot?.repos?.length > 0);
          const filteredRepos = React.useMemo(
            () => (snapshot?.repos || []).filter(matchesFilter),
            [snapshot, lens, searchQuery]
          );

          const renderLinkCard = isModal =>
            h(
              'form',
              {
                className: 'dsa-onboarding-card',
                onSubmit: e => handleLinkSubmit(e, isModal),
                onClick: e => e.stopPropagation(),
              },
              h(
                'div',
                { className: 'dsa-onboarding-head' },
                h(
                  'div',
                  { className: 'dsa-onboarding-icon' },
                  h(SidebarAtlasIcon, { size: 22 })
                ),
                h('h2', { className: 'dsa-onboarding-title' }, t('emptyTitle')),
                h('p', { className: 'dsa-onboarding-sub' }, t('emptySubtitle'))
              ),
              h(
                'div',
                { className: 'dsa-onboarding-tabs' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-onboarding-tab',
                    'data-active': String(linkMode === 'directory'),
                    onClick: () => {
                      setLinkMode('directory');
                      setLinkError(null);
                    },
                  },
                  t('tabDirectory')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-onboarding-tab',
                    'data-active': String(linkMode === 'remote'),
                    onClick: () => {
                      setLinkMode('remote');
                      setLinkError(null);
                    },
                  },
                  t('tabRemote')
                )
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8 } },
                h('input', {
                  type: 'text',
                  className: 'dsa-input',
                  autoFocus: true,
                  placeholder: linkMode === 'directory' ? t('dirPlaceholder') : t('remotePlaceholder'),
                  value: linkInput,
                  onChange: e => {
                    setLinkInput(e.target.value);
                    if (linkError) setLinkError(null);
                  },
                }),
                linkMode === 'directory' &&
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-btn',
                      style: { height: 36, padding: '0 12px', flexShrink: 0 },
                      disabled: pickingDir || linkSubmitting,
                      onClick: handlePickDirectory,
                    },
                    pickingDir ? '打开中…' : t('pickDir')
                  )
              ),
              linkError &&
                h(
                  'div',
                  { style: { fontSize: 11.5, color: 'var(--dsa-danger)', lineHeight: 1.4 } },
                  linkError
                ),
              h(
                'div',
                { style: { display: 'flex', gap: 8 } },
                isModal &&
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-btn',
                      style: { height: 36, padding: '0 16px' },
                      onClick: () => setShowLinkModal(false),
                    },
                    '取消'
                  ),
                h(
                  'button',
                  {
                    type: 'submit',
                    className: 'dsa-btn-primary',
                    disabled: linkSubmitting || !linkInput.trim(),
                  },
                  linkSubmitting ? '关联中…' : t('submitLink')
                )
              )
            );

          return h(
            'div',
            { className: 'dsa-root', 'data-dsh-workspace-atlas': '' },
            h('style', null, css),

            // =================================================================
            // 1. MINIMAL TOP HEADER (Workspace Context | View Switcher | Actions)
            // =================================================================
            h(
              'header',
              { className: 'dsa-header' },
              h(
                'div',
                { className: 'dsa-header-left' },
                h(
                  'div',
                  { className: 'dsa-ws-pill', title: snapshot?.workspace?.path || '' },
                  h('span', { className: 'dsa-dot', 'data-state': isLinked ? 'mounted' : 'skipped' }),
                  !isLinked
                    ? h('span', { style: { color: 'var(--dsa-muted)', fontWeight: 500 } }, t('unlinked'))
                    : snapshot?.availableWorkspaces?.length > 1
                    ? h(
                        'select',
                        {
                          className: 'dsa-ws-select',
                          value: workspacePath || snapshot?.workspace?.path || '',
                          onChange: e => handleSelectWorkspace(e.target.value),
                        },
                        ...snapshot.availableWorkspaces.map(w =>
                          h('option', { key: w.path, value: w.path }, w.title)
                        )
                      )
                    : h('span', null, snapshot?.workspace?.name || '')
                ),
                isLinked &&
                  h(
                    'span',
                    { className: 'dsa-ws-stat' },
                    h('strong', null, snapshot.workspace.mountedRepos),
                    ` / ${snapshot.workspace.totalRepos} ${t('mounted')}`
                  )
              ),

              isLinked &&
                h(
                  'nav',
                  { className: 'dsa-segmented', 'aria-label': 'Workspace view switcher' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-seg-btn',
                      'data-active': String(viewMode === 'topology'),
                      onClick: () => setViewMode('topology'),
                    },
                    t('topology')
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-seg-btn',
                      'data-active': String(viewMode === 'repos'),
                      onClick: () => setViewMode('repos'),
                    },
                    t('repositories'),
                    h('span', { className: 'dsa-seg-count' }, snapshot?.repos?.length || 0)
                  )
                ),

              h(
                'div',
                { className: 'dsa-header-right' },
                isLinked &&
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-btn',
                      onClick: () => {
                        setLinkError(null);
                        setShowLinkModal(true);
                      },
                    },
                    `+ ${t('linkAction')}`
                  ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-icon-btn',
                    onClick: () => loadSnapshot(workspacePath, true),
                    title: t('refresh'),
                    'aria-label': t('refresh'),
                  },
                  h(IconRefresh)
                ),
                isLinked &&
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-icon-btn',
                      'data-danger': 'true',
                      onClick: handleUnlinkWorkspace,
                      title: t('unlinkAction'),
                      'aria-label': t('unlinkAction'),
                    },
                    h(IconUnlink)
                  )
              )
            ),

            // =================================================================
            // 2. UNIFIED LENS FILTER & SEARCH BAR (Shown when linked)
            // =================================================================
            isLinked &&
              h(
                'div',
                { className: 'dsa-subbar' },
                h(
                  'div',
                  { className: 'dsa-lens-group' },
                  ...(snapshot.lenses || []).map(l => {
                    const shortLabel = LENS_SHORT_LABELS[l.id] || l.zhLabel;
                    const count =
                      l.id === 'all'
                        ? snapshot.repos.length
                        : l.id === 'mounted'
                        ? snapshot.workspace.mountedRepos
                        : null;
                    return h(
                      'button',
                      {
                        key: l.id,
                        type: 'button',
                        className: 'dsa-lens-btn',
                        'data-active': String(lens === l.id),
                        onClick: () => setLens(l.id),
                      },
                      shortLabel,
                      count !== null &&
                        h(
                          'span',
                          { style: { opacity: 0.7, fontSize: 11, fontVariantNumeric: 'tabular-nums' } },
                          count
                        )
                    );
                  })
                ),
                h(
                  'div',
                  { className: 'dsa-search-box' },
                  h(IconSearch),
                  h('input', {
                    type: 'text',
                    className: 'dsa-search-input',
                    placeholder: t('searchPlaceholder'),
                    value: searchQuery,
                    onChange: e => setSearchQuery(e.target.value),
                  }),
                  searchQuery &&
                    h(
                      'button',
                      {
                        type: 'button',
                        style: {
                          border: 0,
                          background: 'transparent',
                          color: 'var(--dsa-muted)',
                          cursor: 'pointer',
                          padding: 0,
                          fontSize: 11,
                        },
                        onClick: () => setSearchQuery(''),
                        title: '清空搜索',
                      },
                      '✕'
                    )
                )
              ),

            // =================================================================
            // 3. MAIN WORKSPACE STAGE + FLOATING INSPECTOR DRAWER
            // =================================================================
            h(
              'div',
              { className: 'dsa-body' },
              showLinkModal &&
                h(
                  'div',
                  {
                    className: 'dsa-modal-backdrop',
                    onClick: () => setShowLinkModal(false),
                  },
                  renderLinkCard(true)
                ),
              h(
                'main',
                {
                  className: 'dsa-stage',
                  onClick: () => {
                    if (drawerOpen) closeInspector();
                  },
                },
                error
                  ? h(
                      'div',
                      { style: { padding: 32, color: 'var(--dsa-danger)' } },
                      `加载失败: ${error}`
                    )
                  : !snapshot
                  ? h(
                      'div',
                      { style: { padding: 32, color: 'var(--dsa-muted)' } },
                      '正在加载工作区…'
                    )
                  : !isLinked
                  ? h('div', { className: 'dsa-onboarding-wrap' }, renderLinkCard(false))
                  : viewMode === 'topology'
                  ? // --- VIEW A: 4-LANE ARCHITECTURE TOPOLOGY ---
                    h(
                      'div',
                      {
                        className: 'dsa-canvas-scroll',
                        onScroll: () => requestAnimationFrame(recomputeEdges),
                      },
                      h(
                        'div',
                        { ref: stageInnerRef, className: 'dsa-canvas-inner' },
                        h(
                          'svg',
                          {
                            className: 'dsa-edge-svg',
                            width: svgSize.w,
                            height: svgSize.h,
                          },
                          ...svgPaths.map(p =>
                            h('path', {
                              key: p.id,
                              d: p.d,
                              fill: 'none',
                              stroke: p.stroke,
                              strokeWidth: p.strokeWidth,
                              strokeOpacity: p.strokeOpacity,
                              strokeDasharray: p.dash,
                              className: p.animated ? 'dsa-edge-anim' : undefined,
                            })
                          )
                        ),
                        h(
                          'div',
                          { className: 'dsa-columns' },
                          ...(snapshot.columns || []).map(col => {
                            const colRepos = (snapshot.repos || []).filter(r => r.col === col.id);
                            const meta = DOMAIN_META[col.id] || {
                              zhTitle: col.zhLabel || col.label,
                              tone: 'indigo',
                            };
                            return h(
                              'div',
                              { key: col.id, className: 'dsa-col' },
                              h(
                                'div',
                                { className: 'dsa-col-header' },
                                h(
                                  'div',
                                  { className: 'dsa-col-title-wrap' },
                                  h('span', { className: 'dsa-col-dot', 'data-tone': meta.tone }),
                                  h('span', { className: 'dsa-col-title' }, meta.zhTitle)
                                ),
                                h('span', { className: 'dsa-col-count' }, colRepos.length)
                              ),
                              ...colRepos.map(repo => {
                                const isFocused = drawerOpen && repo.id === focusRepoId;
                                const filterOk = matchesFilter(repo);
                                const relOk = !connectedSet || connectedSet.has(repo.id);
                                const isFaded = !filterOk || !relOk;

                                return h(
                                  'div',
                                  {
                                    key: repo.id,
                                    ref: el => {
                                      if (el) nodeRefs.current.set(repo.id, el);
                                      else nodeRefs.current.delete(repo.id);
                                    },
                                    className: 'dsa-node',
                                    'data-mounted': String(repo.mounted),
                                    'data-focused': String(isFocused),
                                    'data-faded': String(isFaded),
                                    onClick: e => inspectRepo(repo.id, e),
                                    onMouseEnter: () => setHoverRepoId(repo.id),
                                    onMouseLeave: () => setHoverRepoId(null),
                                  },
                                  h(
                                    'div',
                                    { className: 'dsa-node-row1' },
                                    h(
                                      'div',
                                      { className: 'dsa-node-title-group' },
                                      h('span', {
                                        className: 'dsa-dot',
                                        'data-state':
                                          repo.mountKind === 'broken'
                                            ? 'broken'
                                            : repo.mounted
                                            ? 'mounted'
                                            : 'skipped',
                                      }),
                                      h('span', { className: 'dsa-node-name', title: repo.path }, repo.id)
                                    ),
                                    h('span', { className: 'dsa-tech-tag' }, formatNodeTechTag(repo.stack))
                                  ),
                                  h(
                                    'div',
                                    { className: 'dsa-node-summary', title: cleanSummaryText(repo.summary) },
                                    cleanSummaryText(repo.summary)
                                  ),
                                  repo.mounted &&
                                    h(
                                      'div',
                                      { className: 'dsa-node-meta' },
                                      h(
                                        'span',
                                        {
                                          className: 'dsa-mono',
                                          style: {
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            maxWidth: '120px',
                                          },
                                        },
                                        `⎇ ${repo.branch || 'HEAD'}`
                                      ),
                                      repo.dirtyCount > 0
                                        ? h(
                                            'span',
                                            {
                                              style: {
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: 4,
                                                color: 'var(--dsa-warn)',
                                                fontWeight: 500,
                                              },
                                              title: repo.dirtyLabel || '',
                                            },
                                            h('span', { className: 'dsa-dirty-dot' }),
                                            `${repo.dirtyCount} 变更`
                                          )
                                        : h(
                                            'span',
                                            { style: { color: 'var(--dsa-success)', fontWeight: 500 } },
                                            t('mounted')
                                          )
                                    )
                                );
                              })
                            );
                          })
                        )
                      )
                    )
                  : // --- VIEW B: CLEAN SINGLE-LINE REPOSITORY MATRIX ---
                    h(
                      'div',
                      { className: 'dsa-matrix-wrap' },
                      h(
                        'div',
                        { className: 'dsa-matrix-inner' },
                        h(
                          'div',
                          { className: 'dsa-table-card' },
                          h(
                            'table',
                            { className: 'dsa-table' },
                            h(
                              'colgroup',
                              null,
                              h('col', { style: { width: '44%' } }),
                              h('col', { style: { width: '14%' } }),
                              h('col', { style: { width: '20%' } }),
                              h('col', { style: { width: '22%' } })
                            ),
                            h(
                              'thead',
                              null,
                              h(
                                'tr',
                                null,
                                h('th', null, '仓库与职责'),
                                h('th', null, '架构域'),
                                h('th', null, '技术栈 / 运行时'),
                                h('th', null, '状态与分支')
                              )
                            ),
                            h(
                              'tbody',
                              null,
                              ...filteredRepos.map(r => {
                                const domain = DOMAIN_META[r.col] || {
                                  badge: r.col,
                                  tone: 'indigo',
                                };
                                const isFocused = drawerOpen && r.id === focusRepoId;
                                const cleanedDesc = cleanSummaryText(r.summary);

                                return h(
                                  'tr',
                                  {
                                    key: r.id,
                                    'data-focused': String(isFocused),
                                    onClick: e => inspectRepo(r.id, e),
                                  },
                                  h(
                                    'td',
                                    { title: `${r.path}\n${cleanedDesc}` },
                                    h(
                                      'div',
                                      { className: 'dsa-repo-cell' },
                                      h(
                                        'div',
                                        { className: 'dsa-repo-cell-top' },
                                        h('span', {
                                          className: 'dsa-dot',
                                          'data-state': r.mounted ? 'mounted' : 'skipped',
                                        }),
                                        h('span', { className: 'dsa-repo-cell-name' }, r.id)
                                      ),
                                      h('div', { className: 'dsa-repo-cell-sub' }, cleanedDesc)
                                    )
                                  ),
                                  h(
                                    'td',
                                    null,
                                    h(
                                      'span',
                                      { className: 'dsa-domain-pill', 'data-tone': domain.tone },
                                      domain.badge
                                    )
                                  ),
                                  h(
                                    'td',
                                    {
                                      style: { color: 'var(--dsa-muted)', fontSize: 12 },
                                      title: r.stack,
                                    },
                                    formatCleanStack(r.stack)
                                  ),
                                  h(
                                    'td',
                                    null,
                                    h(
                                      'div',
                                      { className: 'dsa-status-cell' },
                                      h(
                                        'div',
                                        { className: 'dsa-status-group' },
                                        h(
                                          'span',
                                          {
                                            className: 'dsa-status-pill',
                                            'data-mounted': String(r.mounted),
                                          },
                                          r.mounted ? t('mounted') : t('skippedShort')
                                        ),
                                        r.mounted &&
                                          h(
                                            'span',
                                            {
                                              className: 'dsa-branch-pill dsa-mono',
                                              title: `${r.branch || 'HEAD'} (${r.dirtyLabel || 'clean'})`,
                                            },
                                            r.branch || 'HEAD',
                                            r.dirtyCount > 0 && h('span', { className: 'dsa-dirty-dot' })
                                          )
                                      ),
                                      h('span', { className: 'dsa-row-arrow' }, '›')
                                    )
                                  )
                                );
                              })
                            )
                          )
                        )
                      )
                    )
              ),

              // ===============================================================
              // 4. FLOATING SLIDE-OVER REPOSITORY INSPECTOR
              // ===============================================================
              isLinked &&
                drawerOpen &&
                snapshot &&
                focusedRepo &&
                (() => {
                  const domain = DOMAIN_META[focusedRepo.col] || {
                    badge: focusedRepo.col,
                    tone: 'indigo',
                  };
                  const repoEdges = (snapshot.edges || []).filter(
                    e => e.from === focusedRepo.id || e.to === focusedRepo.id
                  );
                  const hasAnyDocs = Boolean(
                    focusedRepo.docs?.overview ||
                      focusedRepo.docs?.setup ||
                      focusedRepo.docs?.test ||
                      focusedRepo.docs?.capabilities
                  );

                  return h(
                    'aside',
                    {
                      className: 'dsa-drawer',
                      onClick: e => e.stopPropagation(),
                    },
                    // Inspector Hero Header
                    h(
                      'div',
                      { className: 'dsa-drawer-hero' },
                      h(
                        'div',
                        { className: 'dsa-drawer-toprow' },
                        h(
                          'div',
                          { className: 'dsa-drawer-name-group' },
                          h('span', {
                            className: 'dsa-dot',
                            'data-state': focusedRepo.mounted ? 'mounted' : 'skipped',
                          }),
                          h('span', { className: 'dsa-drawer-repo-title' }, focusedRepo.id),
                          h(
                            'span',
                            {
                              className: 'dsa-status-pill',
                              'data-mounted': String(focusedRepo.mounted),
                            },
                            focusedRepo.mounted ? t('mounted') : t('skippedShort')
                          )
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsa-icon-btn',
                            style: { width: 26, height: 26 },
                            onClick: closeInspector,
                            title: '关闭详情 (Esc)',
                          },
                          '✕'
                        )
                      ),
                      h(
                        'div',
                        { className: 'dsa-drawer-path dsa-mono', title: focusedRepo.path },
                        focusedRepo.path
                      ),
                      h('p', { className: 'dsa-drawer-desc' }, cleanSummaryText(focusedRepo.summary)),
                      h(
                        'div',
                        { className: 'dsa-drawer-pills' },
                        h('span', { className: 'dsa-domain-pill', 'data-tone': domain.tone }, domain.badge),
                        h('span', { className: 'dsa-tech-tag' }, formatCleanStack(focusedRepo.stack)),
                        focusedRepo.mounted &&
                          h(
                            'span',
                            { className: 'dsa-branch-pill dsa-mono', style: { maxWidth: 'none' } },
                            `⎇ ${focusedRepo.branch || 'HEAD'}`,
                            focusedRepo.dirtyCount > 0 && ` · ${focusedRepo.dirtyCount} 变更`
                          )
                      )
                    ),

                    // Inspector Section Switcher Tabs
                    h(
                      'div',
                      { className: 'dsa-drawer-tabs' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsa-drawer-tab',
                          'data-active': String(drawerSection === 'relations'),
                          onClick: () => setDrawerSection('relations'),
                        },
                        `依赖与命令 (${repoEdges.length})`
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsa-drawer-tab',
                          'data-active': String(drawerSection === 'docs'),
                          onClick: () => setDrawerSection('docs'),
                        },
                        '知识画像文档'
                      )
                    ),

                    // Inspector Body
                    h(
                      'div',
                      { className: 'dsa-drawer-scroll' },
                      drawerSection === 'relations'
                        ? h(
                            React.Fragment,
                            null,
                            // 1. Cross-Repo Dependencies
                            h(
                              'div',
                              null,
                              h(
                                'div',
                                { className: 'dsa-section-head' },
                                h('span', { className: 'dsa-section-label' }, '上下游契约与依赖边'),
                                h('span', { className: 'dsa-section-count' }, `${repoEdges.length} 条关联`)
                              ),
                              repoEdges.length === 0
                                ? h(
                                    'div',
                                    { style: { fontSize: 12, color: 'var(--dsa-muted)' } },
                                    '暂无跨仓契约依赖记录'
                                  )
                                : h(
                                    'div',
                                    { className: 'dsa-rel-list' },
                                    ...repoEdges.map(edge => {
                                      const isOut = edge.from === focusedRepo.id;
                                      const peerId = isOut ? edge.to : edge.from;
                                      return h(
                                        'div',
                                        {
                                          key: edge.id,
                                          className: 'dsa-rel-item',
                                          onClick: () => setFocusRepoId(peerId),
                                        },
                                        h(
                                          'div',
                                          {
                                            style: {
                                              display: 'flex',
                                              alignItems: 'center',
                                              justifyContent: 'space-between',
                                              gap: 8,
                                            },
                                          },
                                          h(
                                            'span',
                                            { style: { fontWeight: 600, fontSize: 12.5 } },
                                            `${isOut ? '→ 依赖' : '← 承载'} ${peerId}`
                                          ),
                                          h(
                                            'span',
                                            {
                                              style: {
                                                fontSize: 11,
                                                color: edge.jointRegression
                                                  ? 'var(--dsa-warn)'
                                                  : 'var(--dsa-muted)',
                                                fontWeight: edge.jointRegression ? 600 : 400,
                                              },
                                            },
                                            edge.jointRegression
                                              ? `${formatRelationKind(edge.kind)} · 联合回归`
                                              : formatRelationKind(edge.kind)
                                          )
                                        ),
                                        edge.contract &&
                                          h(
                                            'div',
                                            { style: { fontSize: 11.5, color: 'var(--dsa-muted)' } },
                                            cleanSummaryText(edge.contract)
                                          )
                                      );
                                    })
                                  )
                            ),

                            // 2. Capabilities Verified Commands
                            focusedRepo.commands?.length > 0 &&
                              h(
                                'div',
                                null,
                                h(
                                  'div',
                                  { className: 'dsa-section-head' },
                                  h('span', { className: 'dsa-section-label' }, '标准构建与测试命令')
                                ),
                                h(
                                  'div',
                                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                                  ...focusedRepo.commands.map(cmd =>
                                    h(
                                      'div',
                                      { key: cmd.name, className: 'dsa-cmd-row' },
                                      h(
                                        'div',
                                        { style: { minWidth: 0, flex: 1 } },
                                        h(
                                          'div',
                                          { style: { fontWeight: 600, fontSize: 12 } },
                                          cmd.name,
                                          cmd.requires?.length > 0 &&
                                            h(
                                              'span',
                                              {
                                                style: {
                                                  fontWeight: 400,
                                                  fontSize: 11,
                                                  color: 'var(--dsa-muted)',
                                                  marginLeft: 6,
                                                },
                                              },
                                              `· ${cmd.requires.join(', ')}`
                                            )
                                        ),
                                        h(
                                          'div',
                                          {
                                            className: 'dsa-mono',
                                            style: {
                                              fontSize: 11,
                                              color: 'var(--dsa-muted)',
                                              overflow: 'hidden',
                                              textOverflow: 'ellipsis',
                                              whiteSpace: 'nowrap',
                                              marginTop: 2,
                                            },
                                            title: cmd.run,
                                          },
                                          cmd.run
                                        )
                                      ),
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'dsa-copy-btn',
                                          onClick: () => handleCopyCommand(cmd.name, cmd.run),
                                        },
                                        copiedCmd === cmd.name ? '已复制' : '复制'
                                      )
                                    )
                                  )
                                )
                              ),

                            // 3. Quiet Source Path Metadata
                            (focusedRepo.symlinkTarget || focusedRepo.remote) &&
                              h(
                                'div',
                                {
                                  style: {
                                    paddingTop: 10,
                                    borderTop: '1px solid var(--dsa-border)',
                                    fontSize: 11,
                                    color: 'var(--dsa-subtle)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4,
                                  },
                                },
                                focusedRepo.symlinkTarget &&
                                  h(
                                    'div',
                                    {
                                      className: 'dsa-mono',
                                      style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                                      title: focusedRepo.symlinkTarget,
                                    },
                                    `本地路径: ${focusedRepo.symlinkTarget}`
                                  ),
                                focusedRepo.remote &&
                                  h(
                                    'div',
                                    {
                                      className: 'dsa-mono',
                                      style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                                      title: focusedRepo.remote,
                                    },
                                    `远端地址: ${focusedRepo.remote}`
                                  )
                              )
                          )
                        : // TAB 2: STRUCTURED KNOWLEDGE PROFILE DOCS
                          h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                            hasAnyDocs &&
                              h(
                                'div',
                                { className: 'dsa-segmented', style: { alignSelf: 'flex-start' } },
                                ...DOC_TABS.map(tab =>
                                  h(
                                    'button',
                                    {
                                      key: tab.id,
                                      type: 'button',
                                      className: 'dsa-seg-btn',
                                      style: { padding: '3px 10px', fontSize: 11.5 },
                                      'data-active': String(docTab === tab.id),
                                      onClick: () => setDocTab(tab.id),
                                    },
                                    tab.label
                                  )
                                )
                              ),
                            focusedRepo.docs?.[docTab]
                              ? docTab === 'capabilities'
                                ? h('pre', { className: 'dsa-md-pre' }, focusedRepo.docs.capabilities)
                                : renderStructuredDoc(focusedRepo.docs[docTab])
                              : h(
                                  'div',
                                  { className: 'dsa-md-card', style: { color: 'var(--dsa-muted)' } },
                                  '当前分项暂无本地画像文档记录'
                                )
                          )
                    )
                  );
                })()
            )
          );
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: -40,
              label: () => t('title'),
            },
            SidebarAtlasIcon
          )
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            AtlasMainPage
          )
        );
      },
    };
  },
});
