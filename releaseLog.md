### 更新记录：
#### 每一代版本更新，bug修复都是利用提供账号的用户贡献的，感谢每一位热心参与脚本发展的用户。
+ 1.0.0 大更新，改善了界面效果，开始逐渐融合各种雨课堂版本。代码量提升至500余行。
+ 2.1.0 小更新，之前版本号从0.0.1开始算，觉得不妥，现在改为1.0.5 -> 2.1.0.新增一条刷课线路。
+ 2023.10.1 代码托管到github,欢迎各位开发者提出 pull request.为脚本填一份力量。
+ 解决了雨课堂进入后台意外暂停,更改rate为1后,仍然二倍速,进入批量意外卡顿的bug
+ 修复了课程已经刷完，直接检测导致observer为undefined的问题，舍弃了playOut()的判断方法
+ 2023.11.10 2.1.6 修复网站更新出现bug
+ 2023.11.17 2.2.0 增加错误页面匹配提醒 && 修改倍速函数，支持3倍速
+ 2023.11.21 2.2.1 匹配所有可刷的雨课堂网址，增加倍速显示
+ 2023.11.22 2.2.3 增加私有对象，防止其他脚本影响
+ 2023.11.23 2.2.4 雨课堂更新，去掉了批量字样，修复
+ 2023.11.23 2.2.5 修复因课件过期问题导致报错bug
+ 2023.11.26 2.2.6 修复课件ppt刷无效的情况，以及刷完意外进入批量区的情况
+ 2023.11.27 2.2.7 修复雨课堂视频意外暂停的问题，自动强制播放
+ 2023.12.17 2.3.0 修复意外bug情况
+ 2023.12.20 2.3.1 修复某些课件因为end为null而意外跳过的bug
+ 2023.12.21 2.3.2 使用动态选择器以避免。
+ 2024.01.31 2.4.0 优化了代码结构，使用了shadowroot隐藏节点，抛弃了jquery库。用纯JS代码编写。
+ 2024.01.31 2.4.1 去除赞赏码，修改脚本协议为GPL3。
+ 2024.02.09 2.4.2 修复pro/lms路线的刷课问题。
+ 2024.03.15 2.4.3 修复视频开始意外暂停bug，优化代码结构
+ 2024.03.19 2.4.4 修复解决了pro/lms路线雨课堂切屏检测问题
+ 2024.03.28 2.4.5 优化代码结构
+ 2024.06.09 2.4.6 修复了课件ppt视频被忽略的问题
+ 2024.06.12 2.4.7 新增自动播放批量里的音频课程
+ 2024.06.12 2.4.8 修复几分钟前我埋下来的雷...
+ 2024.09.10 2.4.9 修复pro/lms路线遇见非视频课程卡住的情况
+ 2024.10.08 2.4.10 修复了web/v2路线课堂音频卡住的问题
+ 2024.10.21 2.4.11 修复了web/v2课堂视频意外卡住的问题
+ 2024.10.22 2.4.12 刷课学校新增广州财经大学