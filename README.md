# 用桌面端参与众测

1. 从 [GitHub](https://github.com/kotot/dsh-crowdtest/releases/latest) 下载插件安装包，在 DeepSeek Harness「插件」页添加并启用。
2. 在众测评测页点击「在本机运行」，复制完整命令（含口令和平台地址），在桌面端任意会话中发送。
3. 插件自动配置模型、下载附件并新建任务会话，在新会话中完成任务。
4. 每轮结束自动备份。结束前确认输入框上方显示「已同步」，有内容待同步时点击「立即同步」。

![众测插件使用指南](./usage-guide.png)

打开已启用的插件详情页会自动检查更新。有新版时点击右上角「更新到 x.y.z」。如果更新失败，标题旁会显示原因，可点击「检查更新」重试。安装完成后，完全退出并重新打开 DSH。

从 0.2.18 起，插件直接读取 GitHub Releases 的公开更新文件，无需 GitHub 令牌。若正在使用 0.2.17 或更早版本，且更新遇到限额或要求令牌，请从 [GitHub Releases](https://github.com/kotot/dsh-crowdtest/releases/latest) 下载 0.2.18 或更新版本的 `dsh-crowdtest.tgz`，在 DSH「插件」页添加安装包，再完全退出并重新打开 DSH。
