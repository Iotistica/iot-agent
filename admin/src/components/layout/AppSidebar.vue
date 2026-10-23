
/* ==========================================
   IOTISTICA THEME
   Light + Dark Mode
   Concept B - Unified Application Header
========================================== */

/* ==========================================
   LIGHT THEME
========================================== */

:root {
  /* Application backgrounds */
  --bg-body: #f0f2f5;
  --bg-container: #ffffff;
  --bg-elevated: #ffffff;
  --bg-subtle: #f5f5f5;
  --bg-hover: #fafafa;
  --bg-card-header: #f7f9fb;
  --bg-code: #f6f6f6;
  --bg-table-header: #f7f9fc;
  --bg-table-hover: #f5f9ff;
  --bg-stat-card: #fafafa;
  --bg-panel: #fafafa;
  --bg-selected: #e6f4ff;
  --bg-selected-light: #f0f7ff;

  /* Application shell */
  --bg-app-header: #ffffff;
  --bg-sidebar: #ffffff;
  --border-app-header: #e7ebf0;
  --app-header-height: 52px;
  --app-header-accent: #1677ff;

  /* Text */
  --text-primary: rgba(0, 0, 0, 0.88);
  --text-secondary: rgba(0, 0, 0, 0.65);
  --text-tertiary: rgba(0, 0, 0, 0.45);
  --text-heading: rgba(0, 0, 0, 0.85);
  --text-muted: #999;
  --text-placeholder: #bbb;

  /* Borders */
  --border-color: #f0f0f0;
  --border-color-strong: #d9d9d9;
  --border-color-card: #e7ebf0;

  /* Shadows */
  --shadow-card: 0 1px 4px rgba(0, 0, 0, 0.06);
  --shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.1);

  /* Scrollbars */
  --scrollbar-thumb: rgba(0, 0, 0, 0.15);
  --scrollbar-track: transparent;

  /* Icon backgrounds */
  --icon-bg-blue: #edf4ff;
  --icon-bg-green: #eefbf4;
  --icon-bg-purple: #f5f0ff;
  --icon-bg-red: #fff1f2;

  /* Running status */
  --badge-running-bg: #e6f4ff;
  --badge-running-color: #1677ff;
  --badge-running-border: #bae0ff;

  /* Stopped status */
  --badge-stopped-bg: #fff2f0;
  --badge-stopped-color: #ff4d4f;
  --badge-stopped-border: #ffccc7;
}

/* ==========================================
   DARK THEME
========================================== */

[data-theme="dark"] {
  /* Application backgrounds */
  --bg-body: #141414;
  --bg-container: #1f1f1f;
  --bg-elevated: #262626;
  --bg-subtle: #262626;
  --bg-hover: #303030;
  --bg-card-header: #262626;
  --bg-code: #2a2a2a;
  --bg-table-header: #1a1a1a;
  --bg-table-hover: #262626;
  --bg-stat-card: #1a1a1a;
  --bg-panel: #1a1a1a;
  --bg-selected: #111d2c;
  --bg-selected-light: #111a2c;

  /* Unified application header */
  --bg-app-header: #191c20;
  --bg-sidebar: #141619;
  --border-app-header: #30343a;
  --app-header-height: 52px;
  --app-header-accent: #1677ff;

  /* Text */
  --text-primary: rgba(255, 255, 255, 0.88);
  --text-secondary: rgba(255, 255, 255, 0.65);
  --text-tertiary: rgba(255, 255, 255, 0.45);
  --text-heading: rgba(255, 255, 255, 0.85);
  --text-muted: rgba(255, 255, 255, 0.35);
  --text-placeholder: rgba(255, 255, 255, 0.25);

  /* Borders */
  --border-color: #424242;
  --border-color-strong: #555555;
  --border-color-card: #424242;

  /* Shadows */
  --shadow-card: 0 1px 4px rgba(0, 0, 0, 0.3);
  --shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.5);

  /* Scrollbars */
  --scrollbar-thumb: rgba(255, 255, 255, 0.15);
  --scrollbar-track: transparent;

  /* Icon backgrounds */
  --icon-bg-blue: rgba(22, 119, 255, 0.15);
  --icon-bg-green: rgba(82, 196, 26, 0.15);
  --icon-bg-purple: rgba(114, 46, 209, 0.15);
  --icon-bg-red: rgba(240, 68, 82, 0.15);

  /* Running status */
  --badge-running-bg: rgba(22, 119, 255, 0.15);
  --badge-running-color: #4096ff;
  --badge-running-border: rgba(22, 119, 255, 0.3);

  /* Stopped status */
  --badge-stopped-bg: rgba(255, 77, 79, 0.15);
  --badge-stopped-color: #ff7875;
  --badge-stopped-border: rgba(255, 77, 79, 0.3);
}

/* ==========================================
   GLOBAL BODY
========================================== */

body {
  background: var(--bg-body);
  color: var(--text-primary);

  transition:
    background-color 0.3s,
    color 0.3s;
}

/* ==========================================
   ANT DESIGN LAYOUT
========================================== */

[data-theme="dark"] .ant-layout {
  background: var(--bg-body);
}

[data-theme="dark"] .ant-layout-header {
  background: var(--bg-app-header);
}

[data-theme="dark"] .ant-layout-content {
  background: transparent;
}

[data-theme="dark"] .ant-layout-sider {
  background: var(--bg-sidebar) !important;
}

/* ==========================================
   APPLICATION HEADER + SIDEBAR
========================================== */

/* Header styling is shared by both themes */

.page-header {
  background: var(--bg-app-header);
  border-bottom-color: var(--border-app-header);
}

/* Sidebar shell */

.app-sidebar.ant-layout-sider {
  background: var(--bg-sidebar) !important;
}

/* Logo header */

.app-sidebar .sidebar-brand {
  height: var(--app-header-height);
  min-height: var(--app-header-height);
  box-sizing: border-box;

  background: var(--bg-app-header);
  border-bottom: 1px solid var(--border-app-header);
}

/* Vertical boundary between sidebar and content */

.app-sidebar.ant-layout-sider {
  border-right: 1px solid var(--border-app-header);
}

/* Sidebar internal layout */

.app-sidebar .ant-layout-sider-children {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* Sidebar navigation */

.app-sidebar .nav-main,
.app-sidebar .nav-bottom,
.app-sidebar .sidebar-footer {
  background: var(--bg-sidebar);
}

/* ==========================================
   ANT DESIGN TABLE
========================================== */

[data-theme="dark"] .ant-table {
  background: var(--bg-container);
  color: var(--text-primary);
}

[data-theme="dark"] .ant-table-thead > tr > th,
[data-theme="dark"] .ant-table-thead > tr > td {
  background: var(--bg-table-header) !important;
  color: var(--text-secondary) !important;
  border-bottom-color: var(--border-color) !important;
}

[data-theme="dark"] .ant-table-tbody > tr > td {
  border-bottom-color: var(--border-color) !important;
}

[data-theme="dark"] .ant-table-tbody > tr:hover > td {
  background: var(--bg-table-hover) !important;
}

[data-theme="dark"] .ant-table-cell-row-hover {
  background: var(--bg-table-hover) !important;
}

/* ==========================================
   ANT DESIGN CARDS
========================================== */

[data-theme="dark"] .ant-card {
  background: var(--bg-container);
  border-color: var(--border-color);
}

[data-theme="dark"] .ant-card-head {
  border-bottom-color: var(--border-color);
}

/* ==========================================
   ANT DESIGN DRAWERS
========================================== */

[data-theme="dark"] .ant-drawer-content {
  background: var(--bg-container);
}

[data-theme="dark"] .ant-drawer-header {
  border-bottom-color: var(--border-color);
}

[data-theme="dark"] .ant-drawer-footer {
  border-top-color: var(--border-color);
}

/* ==========================================
   ANT DESIGN MODALS
========================================== */

[data-theme="dark"] .ant-modal-content {
  background: var(--bg-container);
}

[data-theme="dark"] .ant-modal-header {
  background: var(--bg-container);
  border-bottom-color: var(--border-color);
}

/* ==========================================
   ANT DESIGN FORMS
========================================== */

[data-theme="dark"] .ant-form-item-label > label {
  color: var(--text-primary);
}

/* ==========================================
   INPUTS AND SELECTS
========================================== */

[data-theme="dark"] .ant-input,
[data-theme="dark"] .ant-input-affix-wrapper,
[data-theme="dark"] .ant-select-selector,
[data-theme="dark"] .ant-picker,
[data-theme="dark"] .ant-input-number {
  background: var(--bg-elevated) !important;
  border-color: var(--border-color-strong) !important;
  color: var(--text-primary) !important;
}

[data-theme="dark"] .ant-select-dropdown {
  background: var(--bg-elevated);
}

/* ==========================================
   ANT DESIGN TABS
========================================== */

[data-theme="dark"] .ant-tabs-nav::before {
  border-bottom-color: var(--border-color) !important;
}

/* ==========================================
   ANT DESIGN COLLAPSE
========================================== */

[data-theme="dark"] .ant-collapse {
  background: var(--bg-subtle);
  border-color: var(--border-color);
}

[data-theme="dark"] .ant-collapse-item {
  border-bottom-color: var(--border-color) !important;
}

[data-theme="dark"] .ant-collapse-content {
  background: var(--bg-container);
  border-top-color: var(--border-color);
}

/* ==========================================
   ANT DESIGN TAGS
========================================== */

[data-theme="dark"] .ant-tag.ant-tag-default {
  background: var(--bg-subtle);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

/* ==========================================
   ANT DESIGN PAGINATION
========================================== */

[data-theme="dark"] .ant-pagination-item {
  background: var(--bg-container);
  border-color: var(--border-color-strong);
}

[data-theme="dark"] .ant-pagination-item a {
  color: var(--text-primary);
}

/* ==========================================
   ANT DESIGN EMPTY
========================================== */

[data-theme="dark"] .ant-empty-description {
  color: var(--text-tertiary);
}

/* ==========================================
   ANT DESIGN ALERT
========================================== */

[data-theme="dark"] .ant-alert {
  border-color: var(--border-color);
}

/* ==========================================
   ANT DESIGN DESCRIPTIONS
========================================== */

[data-theme="dark"]
.ant-descriptions-bordered
.ant-descriptions-item-label {
  background: var(--bg-subtle);
}

/* ==========================================
   ANT DESIGN SEGMENTED
========================================== */

[data-theme="dark"] .ant-segmented {
  background: var(--bg-subtle);
}

/* ==========================================
   ANT DESIGN TOOLTIP
========================================== */

[data-theme="dark"] .ant-tooltip-inner {
  background: var(--bg-elevated);
}

/* ==========================================
   ANT DESIGN SWITCH
========================================== */

[data-theme="dark"]
.ant-switch:not(.ant-switch-checked) {
  background: var(--bg-subtle);
}

/* ==========================================
   ANT DESIGN PROGRESS
========================================== */

[data-theme="dark"] .ant-progress-inner {
  background: var(--bg-subtle) !important;
}

/* ==========================================
   ANT DESIGN STATISTIC
========================================== */

[data-theme="dark"] .ant-statistic-title {
  color: var(--text-tertiary);
}

[data-theme="dark"] .ant-statistic-content {
  color: var(--text-primary);
}

/* ==========================================
   ANT DESIGN SPIN
========================================== */

[data-theme="dark"] .ant-spin-container::after {
  background: var(--bg-container);
}
