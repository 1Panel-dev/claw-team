/**
 * 这个文件负责统一注册前端基础 Provider。
 *
 * 之所以单独抽出来，是为了让 main.ts 保持干净，
 * 也方便后面追加国际化、错误边界、埋点等全局能力。
 *
 * 这里同时负责按需注册 Element Plus 组件。
 * 这样可以避免把整个 Element Plus 运行时代码都打进主包里。
 */
import type { App } from "vue";
import { createPinia } from "pinia";
import ElButton from "element-plus/es/components/button/index";
import ElConfigProvider from "element-plus/es/components/config-provider/index";
import ElDrawer from "element-plus/es/components/drawer/index";
import ElEmpty from "element-plus/es/components/empty/index";
import { ElForm, ElFormItem } from "element-plus/es/components/form/index";
import ElIcon from "element-plus/es/components/icon/index";
import ElInput from "element-plus/es/components/input/index";
import ElInputNumber from "element-plus/es/components/input-number/index";
import ElPopover from "element-plus/es/components/popover/index";
import { ElRadioButton, ElRadioGroup } from "element-plus/es/components/radio/index";
import { ElOption, ElOptionGroup, ElSelect } from "element-plus/es/components/select/index";
import ElSwitch from "element-plus/es/components/switch/index";
import { ElTabPane, ElTabs } from "element-plus/es/components/tabs/index";
import { ElAutoResizer, ElTableV2 } from "element-plus/es/components/table-v2/index";

import "element-plus/es/components/button/style/css";
import "element-plus/es/components/empty/style/css";
import "element-plus/es/components/drawer/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/icon/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/option-group/style/css";
import "element-plus/es/components/popover/style/css";
import "element-plus/es/components/radio/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/tabs/style/css";
import "element-plus/es/components/table-v2/style/css";

import { router } from "@/router";

export function registerProviders(app: App<Element>): void {
    app.use(createPinia());
    app.use(router);
    app.component("ElButton", ElButton);
    app.component("ElConfigProvider", ElConfigProvider);
    app.component("ElDrawer", ElDrawer);
    app.component("ElEmpty", ElEmpty);
    app.component("ElForm", ElForm);
    app.component("ElFormItem", ElFormItem);
    app.component("ElIcon", ElIcon);
    app.component("ElInput", ElInput);
    app.component("ElInputNumber", ElInputNumber);
    app.component("ElOption", ElOption);
    app.component("ElOptionGroup", ElOptionGroup);
    app.component("ElPopover", ElPopover);
    app.component("ElRadioButton", ElRadioButton);
    app.component("ElRadioGroup", ElRadioGroup);
    app.component("ElSelect", ElSelect);
    app.component("ElSwitch", ElSwitch);
    app.component("ElTabs", ElTabs);
    app.component("ElTabPane", ElTabPane);
    app.component("ElAutoResizer", ElAutoResizer);
    app.component("ElTableV2", ElTableV2);
}
