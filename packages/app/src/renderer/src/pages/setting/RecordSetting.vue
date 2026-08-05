<template>
  <div class="">
    <div style="display: flex; gap: 10px; align-items: center">
      <h2>录制配置</h2>
      <p>此项大部分配置不即时生效，需重新开始一个录制方可生效</p>
    </div>

    <n-form label-placement="left" :label-width="145">
      <n-tabs type="segment" style="margin-top: 10px" class="tabs">
        <n-tab-pane
          class="tab-pane"
          name="common-setting"
          tab="基础设置"
          display-directive="show:lazy"
        >
          <n-form-item>
            <template #label>
              <span class="inline-flex"> 保存文件夹 </span>
            </template>
            <n-input v-model:value="config.recorder.savePath" placeholder="请选择要保存的文件夹" />
            <n-icon style="margin-left: 10px" size="26" class="pointer" @click="selectFolder">
              <FolderOpenOutline />
            </n-icon>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :tip="titleTip" text="文件命名规则"></Tip>
            </template>
            <n-input
              ref="titleInput"
              :disabled="!allowEdit"
              v-model:value="config.recorder.nameRule"
              placeholder="请输入文件命名规则"
              clearable
              spellcheck="false"
              @blur="handleNameRuleBlur"
            />
            <n-checkbox v-model:checked="allowEdit" style="margin: 0 10px"></n-checkbox>
            <template #feedback>
              <span
                v-for="item in titleList"
                :key="item.value"
                :title="item.label"
                class="title-var"
                @click="setTitleVar(item.value)"
                >{{ item.value }}</span
              >
            </template>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.checkInterval.tip"
                :text="textInfo.common.checkInterval.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.checkInterval"
              min="10"
              step="10"
              style="width: 220px"
            >
              <template #suffix>秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.maxThreadCount.tip"
                :text="textInfo.common.maxThreadCount.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.maxThreadCount"
              min="1"
              max="10"
              step="1"
              style="width: 220px"
            >
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :tip="textInfo.common.waitTime.tip" :text="textInfo.common.waitTime.text"></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.waitTime"
              min="0"
              step="1"
              style="width: 220px"
            >
              <template #suffix>毫秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                tip="0为不分段，默认为时间分段，单位分钟。<br/>如果以B,KB,MB,GB结尾，会尝试使用文件大小分段，<b>不推荐在ffmpeg引擎时使用</b>"
                text="分段"
              ></Tip>
            </template>
            <n-input v-model:value="config.recorder.segment" placeholder="请输入分段参数" />
          </n-form-item>

          <n-form-item>
            <template #label>
              <span> 保存封面 </span>
            </template>
            <n-switch v-model:value="config.recorder.saveCover" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :text="textInfo.common.convert2Mp4.text"
                :tip="textInfo.common.convert2Mp4.tip"
              ></Tip>
            </template>
            <n-switch v-model:value="config.recorder.convert2Mp4" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.common.format.text" :tip="textInfo.common.format.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.videoFormat"
              :options="videoFormatOptions"
              style="width: 220px"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :text="textInfo.common.recorderType.text"
                :tip="textInfo.common.recorderType.tip"
              ></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.recorderType"
              :options="recorderTypeOptions"
              style="width: 220px"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.douyu.qualityRetry.tip"
                :text="textInfo.douyu.qualityRetry.text"
              ></Tip>
            </template>
            <n-input-number v-model:value="config.recorder.qualityRetry" min="-1" step="1">
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                tip="录制结束后，立即尝试重新检查，避免下一个检查周期到来时才进行检查，导致缺少部分时间。<br/>
                每场直播最多进行五十次重试。"
                text="录制结束立即重试"
              ></Tip>
            </template>
            <n-switch v-model:value="config.recorder.recordRetryImmediately" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip tip="如果你遇到特定直播间的录制问题，请打开此开关" text="调试模式"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.debugLevel"
              :options="recorderDebugLevelOptions"
              style="width: 220px"
            />
          </n-form-item>

          <h3>弹幕</h3>
          <n-form-item>
            <template #label>
              <span class="inline-flex"> 弹幕录制 </span>
            </template>
            <n-switch
              v-model:value="config.recorder.disableProvideCommentsWhenRecording"
              :checked-value="false"
              :unchecked-value="true"
            />
          </n-form-item>
          <n-form-item v-if="!config.recorder.disableProvideCommentsWhenRecording">
            <template #label>
              <span class="inline-flex"> 保存礼物 </span>
            </template>
            <n-switch v-model:value="config.recorder.saveGiftDanma" />
          </n-form-item>
          <n-form-item v-if="!config.recorder.disableProvideCommentsWhenRecording">
            <template #label>
              <span class="inline-flex"> 高能弹幕(SC) </span>
            </template>
            <n-switch v-model:value="config.recorder.saveSCDanma" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                text="服务端时间戳"
                tip="使用服务端返回的弹幕时间戳而非本地收到的时间戳，用于处理某些主播的弹幕时间戳不准确的问题"
              ></Tip>
            </template>
            <n-switch v-model:value="config.recorder.useServerTimestamp" />
          </n-form-item>
        </n-tab-pane>
        <n-tab-pane class="tab-pane" name="bilibili" tab="B站" display-directive="show:lazy">
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.bili.uid.text">{{ textInfo.bili.uid.tip }}</Tip>
            </template>
            <n-select
              v-model:value="config.recorder.bilibili.uid"
              :options="userList"
              label-field="name"
              value-field="uid"
              clearable
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.bili.quality.text" :tip="textInfo.bili.quality.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.bilibili.quality"
              :options="biliQualityOptions"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.bili.formatName.text" :tip="textInfo.bili.formatName.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.bilibili.formatName"
              :options="biliStreamFormatOptions"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.bili.codecName.text" :tip="textInfo.bili.codecName.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.bilibili.codecName"
              :options="streamCodecOptions"
            />
          </n-form-item>
          <n-form-item v-if="config.recorder.bilibili.formatName !== 'flv_only'">
            <template #label>
              <Tip
                :tip="textInfo.bili.useM3U8Proxy.tip"
                :text="textInfo.bili.useM3U8Proxy.text"
              ></Tip>
            </template>
            <n-switch v-model:value="config.recorder.bilibili.useM3U8Proxy" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :tip="textInfo.bili.customHost.tip" :text="textInfo.bili.customHost.text"></Tip>
            </template>
            <n-input
              v-model:value="config.recorder.bilibili.customHost"
              placeholder="例如：cn-jsyz-ct-03-32.bilivideo.com"
              clearable
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                tip="使用批量检查直播状态接口，如果你录制了大量的直播间，可以尝试开启此选项，减少被风控的可能性"
                text="批量查询接口"
              ></Tip>
            </template>
            <n-switch v-model:value="config.recorder.bilibili.useBatchQuery" />
          </n-form-item>
          <div class="divider"></div>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.checkInterval.tip"
                :text="textInfo.common.checkInterval.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.bilibili.checkInterval"
              min="10"
              step="10"
              style="width: 220px"
              :placeholder="textInfo.common.checkInterval.placeholder"
            >
              <template #suffix>秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.maxThreadCount.tip"
                :text="textInfo.common.maxThreadCount.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.bilibili.maxThreadCount"
              min="1"
              max="10"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.maxThreadCount.placeholder"
            >
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.common.waitTime.text" :tip="textInfo.common.waitTime.tip"></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.bilibili.waitTime"
              min="0"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.waitTime.placeholder"
            >
              <template #suffix>毫秒</template>
            </n-input-number>
          </n-form-item>
        </n-tab-pane>
        <n-tab-pane class="tab-pane" name="douyu" tab="斗鱼" display-directive="show:lazy">
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.douyu.quality.text" :tip="textInfo.douyu.quality.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.douyu.quality"
              :options="douyuQualityOptions"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip text="线路" tip="如果设置的不存在，会采用默认"></Tip>
            </template>
            <n-select v-model:value="config.recorder.douyu.source" :options="douyuSourceOptions" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.douyu.api.text" :tip="textInfo.douyu.api.tip"></Tip>
            </template>
            <n-select v-model:value="config.recorder.douyu.api" :options="douyuApiTypeOptions" />
          </n-form-item>
          <n-form-item v-if="config.recorder.douyu.api !== 'oldAPI'">
            <template #label>
              <Tip :text="textInfo.douyu.codecName.text" :tip="textInfo.douyu.codecName.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.douyu.codecName"
              :options="douyuStreamCodecOptions"
            />
          </n-form-item>

          <div class="divider"></div>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.checkInterval.tip"
                :text="textInfo.common.checkInterval.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.douyu.checkInterval"
              min="10"
              step="10"
              style="width: 220px"
              :placeholder="textInfo.common.checkInterval.placeholder"
            >
              <template #suffix>秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.maxThreadCount.tip"
                :text="textInfo.common.maxThreadCount.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.douyu.maxThreadCount"
              min="1"
              max="10"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.maxThreadCount.placeholder"
            >
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.common.waitTime.text" :tip="textInfo.common.waitTime.tip"></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.douyu.waitTime"
              min="0"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.waitTime.placeholder"
            >
              <template #suffix>毫秒</template>
            </n-input-number>
          </n-form-item>
        </n-tab-pane>
        <n-tab-pane class="tab-pane" name="huya" tab="虎牙" display-directive="show:lazy">
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.huya.quality.text" :tip="textInfo.huya.quality.tip"></Tip>
            </template>
            <n-select v-model:value="config.recorder.huya.quality" :options="huyaQualityOptions" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.huya.formatName.text" :tip="textInfo.huya.formatName.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.huya.formatName"
              :options="douyinStreamFormatOptions"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip text="线路"></Tip>
            </template>
            <n-select v-model:value="config.recorder.huya.source" :options="huyaSourceOptions" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.huya.api.text" :tip="textInfo.huya.api.tip"></Tip>
            </template>
            <n-select v-model:value="config.recorder.huya.api" :options="huyaApiTypeOptions" />
          </n-form-item>

          <div class="divider"></div>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.checkInterval.tip"
                :text="textInfo.common.checkInterval.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.huya.checkInterval"
              min="10"
              step="10"
              style="width: 220px"
              :placeholder="textInfo.common.checkInterval.placeholder"
            >
              <template #suffix>秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.maxThreadCount.tip"
                :text="textInfo.common.maxThreadCount.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.huya.maxThreadCount"
              min="1"
              max="10"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.maxThreadCount.placeholder"
            >
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.common.waitTime.text" :tip="textInfo.common.waitTime.tip"></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.huya.waitTime"
              min="0"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.waitTime.placeholder"
            >
              <template #suffix>毫秒</template>
            </n-input-number>
          </n-form-item>
        </n-tab-pane>
        <n-tab-pane class="tab-pane" name="douyin" tab="抖音" display-directive="show:lazy">
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.douyin.quality.text" :tip="textInfo.douyin.quality.tip"></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.douyin.quality"
              :options="douyinQualityOptions"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :text="textInfo.douyin.formatName.text"
                :tip="textInfo.douyin.formatName.tip"
              ></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.douyin.formatName"
              :options="douyinStreamFormatOptions"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.douyin.api.text" :tip="textInfo.douyin.api.tip"></Tip>
            </template>
            <n-select v-model:value="config.recorder.douyin.api" :options="douyinApiTypeOptions" />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                text="Cookie模式"
                tip="关闭：录制流程不注入 Cookie；启用：录制中持续注入 Cookie，并在账号池 Cookie 失败后尝试切换到下一个启用账号。旧版仅保存礼物配置会自动按启用处理。"
              ></Tip>
            </template>
            <n-select
              v-model:value="config.recorder.douyin.mode"
              :options="douyinCookieModeOptions"
              style="width: 220px"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip text="账号池" tip="维护多个抖音Cookie账号，启用项会参与运行时选择"></Tip>
            </template>
            <div style="display: flex; width: 100%; flex-direction: column; gap: 10px">
              <div style="display: flex; gap: 10px">
                <n-button type="primary" ghost style="width: fit-content" @click="addGlobalDouyinAccount"
                  >新增账号</n-button
                >
                <n-button type="primary" style="width: fit-content" @click="handleDouyinScanLogin"
                  >扫码登录</n-button
                >
              </div>
              <div
                v-for="account in globalDouyinAccountsSorted"
                :key="account.id"
                style="display: flex; gap: 10px; align-items: center"
              >
                <span
                  v-if="account.updatedAt"
                  style="
                    font-size: 12px;
                    color: rgba(0, 0, 0, 0.45);
                    white-space: nowrap;
                    flex-shrink: 0;
                    line-height: 1.2;
                    min-width: 92px;
                  "
                  >{{ account.updatedAt }}</span
                >
                <n-input
                  v-model:value="account.remark"
                  placeholder="备注（如主号/备号）"
                  style="width: 180px"
                />
                <n-input
                  v-model:value="account.cookie"
                  type="password"
                  placeholder="请输入Cookie"
                  style="width: 260px"
                />
                <n-input-number
                  v-model:value="account.weight"
                  :min="1"
                  :show-button="false"
                  placeholder="随机"
                  clearable
                  :parse="(val: string) => (val ? Number(val.replace(/\D/g, '')) : null)"
                  :format="(val: number | null) => (val ? String(val) : '')"
                  style="width: 100px"
                >
                  <template #prefix>权重</template>
                </n-input-number>
                <n-switch v-model:value="account.enabled" />
                <n-button type="error" ghost @click="removeGlobalDouyinAccount(account.id)"
                  >删除</n-button
                >
              </div>
            </div>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip text="双屏直播流" tip="开启后如果是双屏直播，那么就使用拼接的流"></Tip>
            </template>
            <n-switch v-model:value="config.recorder.douyin.doubleScreen" />
          </n-form-item>

          <div class="divider"></div>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.checkInterval.tip"
                :text="textInfo.common.checkInterval.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.douyin.checkInterval"
              min="10"
              step="10"
              style="width: 220px"
              :placeholder="textInfo.common.checkInterval.placeholder"
            >
              <template #suffix>秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.maxThreadCount.tip"
                :text="textInfo.common.maxThreadCount.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.douyin.maxThreadCount"
              min="1"
              max="10"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.maxThreadCount.placeholder"
            >
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.common.waitTime.text" :tip="textInfo.common.waitTime.tip"></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.douyin.waitTime"
              min="0"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.waitTime.placeholder"
            >
              <template #suffix>毫秒</template>
            </n-input-number>
          </n-form-item>
        </n-tab-pane>
        <n-tab-pane class="tab-pane" name="xhs" tab="小红书" display-directive="show:lazy">
          <h3 style="margin-bottom: 10px">设置Cookie可自动监听，建议使用小号</h3>
          <n-form-item>
            <template #label>
              <Tip text="Cookie" tip="用于自动监听"></Tip>
            </template>
            <n-input v-model:value="config.recorder.xhs.cookie" type="password" />
            <n-button
              v-if="!isWeb"
              type="primary"
              style="margin-left: 10px"
              @click="xhsLogin"
              title="登录后退出即可获取cookie，小红书一个帐号只能登录一端"
              >登录</n-button
            >
          </n-form-item>

          <div class="divider"></div>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.checkInterval.tip"
                :text="textInfo.common.checkInterval.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.xhs.checkInterval"
              min="10"
              step="10"
              style="width: 220px"
              :placeholder="textInfo.common.checkInterval.placeholder"
            >
              <template #suffix>秒</template>
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip
                :tip="textInfo.common.maxThreadCount.tip"
                :text="textInfo.common.maxThreadCount.text"
              ></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.xhs.maxThreadCount"
              min="1"
              max="10"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.maxThreadCount.placeholder"
            >
            </n-input-number>
          </n-form-item>
          <n-form-item>
            <template #label>
              <Tip :text="textInfo.common.waitTime.text" :tip="textInfo.common.waitTime.tip"></Tip>
            </template>
            <n-input-number
              v-model:value="config.recorder.xhs.waitTime"
              min="0"
              step="1"
              style="width: 220px"
              :placeholder="textInfo.common.waitTime.placeholder"
            >
              <template #suffix>毫秒</template>
            </n-input-number>
          </n-form-item>
        </n-tab-pane>
      </n-tabs>
    </n-form>
    <DouyinLoginDialog v-model="showDouyinLoginDialog" @success="handleDouyinLoginSuccess" />
  </div>
</template>

<script setup lang="ts">
import { FolderOpenOutline } from "@vicons/ionicons5";
import { templateRef } from "@vueuse/core";
import { showDirectoryDialog } from "@renderer/utils/fileSystem";
import { useUserInfoStore } from "@renderer/stores";
import { useConfirm } from "@renderer/hooks";
import { douyinApi } from "@renderer/apis";
import DouyinLoginDialog from "./components/DouyinLoginDialog.vue";
import {
  // qualityOptions,
  biliQualityOptions,
  douyuQualityOptions,
  huyaQualityOptions,
  textInfo,
  biliStreamFormatOptions,
  streamCodecOptions,
  douyinQualityOptions,
  douyuSourceOptions,
  videoFormatOptions,
  douyinStreamFormatOptions,
  huyaSourceOptions,
  recorderTypeOptions,
  recorderDebugLevelOptions,
  douyinApiTypeOptions,
  huyaApiTypeOptions,
  douyinCookieModeOptions,
  douyuStreamCodecOptions,
  douyuApiTypeOptions,
} from "@renderer/enums/recorder";
import {
  createDouyinCookieAccount,
  createDouyinScanLoginRemark,
  findDouyinAccountIndexByApiKey,
  formatDouyinAccountUpdatedAt,
  pickDouyinAccountRemark,
  resolveDouyinApiAccountKey,
  resolveDouyinCookieStableIdentity,
} from "./douyinAccounts";

import type { AppConfig } from "@biliLive-tools/types";

const config = defineModel<AppConfig>("data", {
  default: () => {},
});
const emit = defineEmits<{
  requestSave: [];
}>();

const ensureGlobalDouyinCookieConfig = () => {
  if (!config.value?.recorder?.douyin) {
    return;
  }
  config.value.recorder.douyin.mode = config.value.recorder.douyin.mode === "off" ? "off" : "always";
  if (!Array.isArray(config.value.recorder.douyin.accounts)) {
    config.value.recorder.douyin.accounts = [];
  }
};

const addGlobalDouyinAccount = () => {
  ensureGlobalDouyinCookieConfig();
  config.value.recorder.douyin.accounts.push(createDouyinCookieAccount());
};

const removeGlobalDouyinAccount = (id: string) => {
  ensureGlobalDouyinCookieConfig();
  config.value.recorder.douyin.accounts = config.value.recorder.douyin.accounts.filter(
    (account) => account.id !== id,
  );
};

const globalDouyinAccountsSorted = computed(() => {
  return (config.value?.recorder?.douyin?.accounts ?? [])
    .map((account, index) => ({ account, index }))
    .sort((a, b) => {
      const weightA = Number(a.account.weight ?? 0);
      const weightB = Number(b.account.weight ?? 0);
      if (weightA === weightB) {
        return a.index - b.index;
      }
      return weightA - weightB;
    })
    .map((item) => item.account);
});

watch(
  () => config.value?.recorder?.douyin,
  () => {
    ensureGlobalDouyinCookieConfig();
  },
  {
    immediate: true,
    deep: true,
  },
);

const { userList } = storeToRefs(useUserInfoStore());
const isWeb = computed(() => window.isWeb);

const selectFolder = async () => {
  let file: string | undefined = await showDirectoryDialog({
    defaultPath: config.value.recorder.savePath,
  });

  if (!file) return;
  config.value.recorder.savePath = file;
};
const titleList = ref([
  {
    value: "{platform}",
    label: "平台",
  },
  {
    value: "{channelId}",
    label: "房间号",
  },
  {
    value: "{remarks}",
    label: "备注",
  },
  {
    value: "{owner}",
    label: "主播名",
  },
  {
    value: "{title}",
    label: "标题",
  },
  {
    value: "{year}",
    label: "年",
  },
  {
    value: "{month}",
    label: "月",
  },
  {
    value: "{date}",
    label: "日",
  },
  {
    value: "{hour}",
    label: "时",
  },
  {
    value: "{min}",
    label: "分",
  },
  {
    value: "{sec}",
    label: "秒",
  },
  {
    value: "{ms}",
    label: "毫秒",
  },
]);
const titleTip = computed(() => {
  const base = `<b>谨慎修改，可能会导致无法录制</b><br/>支持ejs引擎，更多参数见文档<br/>`;
  return titleList.value
    .map((item) => {
      return `${item.label}：${item.value}<br/>`;
    })
    .reduce((prev, cur) => prev + cur, base);
});

const titleInput = templateRef("titleInput");
const setTitleVar = async (value: string) => {
  if (!allowEdit.value) return;
  const input = titleInput.value?.inputElRef;
  if (input) {
    // 获取input光标位置
    const start = input.selectionStart ?? config.value.recorder.nameRule.length;
    const end = input.selectionEnd ?? config.value.recorder.nameRule.length;
    const oldValue = config.value.recorder.nameRule;
    config.value.recorder.nameRule = oldValue.slice(0, start) + value + oldValue.slice(end);
    // 设置光标位置
    input.focus();
    await nextTick();
    input.setSelectionRange(start + value.length, start + value.length);
  } else {
    config.value.recorder.nameRule += value;
  }
};

const confirm = useConfirm();
const allowEdit = ref(false);
watch(allowEdit, async (val) => {
  if (val) {
    const [status] = await confirm.warning({
      content: "修改前确保知道此项参数含义，文件名中至少存在时分秒，谨慎修改，可能会导致无法录制",
    });
    if (!status) {
      allowEdit.value = false;
    }
  }
});

const handleNameRuleBlur = async () => {
  if (config.value.recorder.nameRule.includes(":")) {
    const [status] = await confirm.warning({
      content: "你的文件命名规则中可能包含了冒号(:)，该符合无法作为文件名，是否替换为空格？",
    });
    if (!status) {
      return;
    }
    config.value.recorder.nameRule = config.value.recorder.nameRule.replaceAll(":", " ");
  }
};

const confirmCookieLoginRisk = async (platform: string, extraRisk?: string) => {
  const [status] = await confirm.warning({
    title: `${platform} 登录提示`,
    content: [
      "Cookie 会用于相关的 API 请求中。程序请求与浏览器内正常使用所发送的请求不完全一致，能通过分析请求日志识别出来。",
      "软件开发者不对账号发生的任何事情负责，包括并不限于被标记为机器人账号、无法参与各种抽奖和活动等。建议使用小号。",
      "如您知晓您的账号会因以上所列出来的部分原因所导致无法使用或权益受损等情况，并愿意承担由此所会带来的一系列后果，请继续以下的操作，软件开发者不会对您账号所发生的任何后果承担责任。",
      extraRisk,
    ]
      .filter(Boolean)
      .join("\n"),
    positiveText: "继续登录",
    negativeText: "取消",
  });
  return status;
};

const xhsLogin = async () => {
  const status = await confirmCookieLoginRisk(
    "小红书",
    "小红书一个帐号通常只能保持一端登录，继续后可能会影响你当前设备上的登录状态",
  );
  if (!status) return;

  const cookie = await window.api.cookie.xhsLogin();
  config.value.recorder.xhs.cookie = cookie;
};

const showDouyinLoginDialog = ref(false);
const handleDouyinScanLogin = async () => {
  const status = await confirmCookieLoginRisk(
    "抖音",
    "抖音扫码登录后将会将Cookie自动填入账号池，请确保是个人常用或备用小号。",
  );
  if (status) {
    showDouyinLoginDialog.value = true;
  }
};

const handleDouyinLoginSuccess = (cookie: string) => {
  ensureGlobalDouyinCookieConfig();
  const accounts = config.value.recorder.douyin.accounts;
  const stableIdentity = resolveDouyinCookieStableIdentity(cookie);
  const existingByCookie =
    stableIdentity !== ""
      ? accounts.find((account) => resolveDouyinCookieStableIdentity(account.cookie) === stableIdentity)
      : undefined;
  // 新建：weight 保持 null（随机）；同用户：沿用 existingByCookie.weight，不覆盖
  const targetAccount = existingByCookie ?? createDouyinCookieAccount();
  const fallbackRemark =
    targetAccount.remark.trim() !== "" ? targetAccount.remark : createDouyinScanLoginRemark();
  targetAccount.cookie = cookie;
  targetAccount.remark = fallbackRemark;
  targetAccount.updatedAt = formatDouyinAccountUpdatedAt();
  if (existingByCookie === undefined) {
    accounts.push(targetAccount);
  }
  emit("requestSave");

  void (async () => {
    try {
      const identity = await douyinApi.getAccountIdentity(cookie);
      const apiKey = resolveDouyinApiAccountKey(identity);
      if (apiKey !== "") {
        targetAccount.accountUid = apiKey;
      }

      let matchIdx = -1;
      if (apiKey !== "") {
        matchIdx = findDouyinAccountIndexByApiKey(accounts, apiKey);
        if (matchIdx < 0) {
          for (let ai = 0; ai < accounts.length; ai++) {
            const account = accounts[ai];
            if (account === targetAccount) continue;
            if ((account.accountUid ?? "").trim() !== "") continue;
            try {
              const otherIdentity = await douyinApi.getAccountIdentity(account.cookie);
              const otherKey = resolveDouyinApiAccountKey(otherIdentity);
              if (otherKey !== "") {
                account.accountUid = otherKey;
              }
              if (otherKey !== "" && otherKey === apiKey) {
                matchIdx = ai;
                break;
              }
            } catch {
              // 单条旧账号 identity 探测失败时跳过，继续其它账号
            }
          }
        }
      }
      if (matchIdx < 0 && stableIdentity !== "") {
        matchIdx = accounts.findIndex(
          (account) => resolveDouyinCookieStableIdentity(account.cookie) === stableIdentity,
        );
      }
      if (matchIdx < 0) {
        matchIdx = accounts.findIndex(
          (account) => account === targetAccount || account.id === targetAccount.id,
        );
      }
      if (matchIdx < 0) {
        return;
      }

      const kept = accounts[matchIdx];
      const baseRemark = kept.remark.trim() !== "" ? kept.remark : fallbackRemark;
      const enrichedRemark = pickDouyinAccountRemark(identity, baseRemark);
      kept.cookie = cookie;
      kept.remark = enrichedRemark;
      // 同用户合并：刷新日期；保留 kept.weight，不覆盖为 null/随机/1
      kept.updatedAt = formatDouyinAccountUpdatedAt();
      if (apiKey !== "") {
        kept.accountUid = apiKey;
      }
      if (kept !== targetAccount) {
        const targetIdx = accounts.findIndex(
          (account) => account === targetAccount || account.id === targetAccount.id,
        );
        if (targetIdx >= 0 && targetIdx !== matchIdx) {
          accounts.splice(targetIdx, 1);
        }
      }
      emit("requestSave");
    } catch {
      // identity 失败不影响已完成的 Cookie 入池
    }
  })();
};
</script>

<style scoped lang="less">
.item {
  display: flex;
}

.title-var {
  display: inline-block;
  margin-top: 4px;
  margin-right: 10px;
  padding: 4px 8px;
  border-radius: 5px;
  background-color: #f0f0f0;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  margin-bottom: 10px;
  &:not(.disabled):hover {
    background-color: #e0e0e0;
  }
  &.disabled {
    cursor: not-allowed;
  }
}

h1,
h2,
h3 {
  margin: 0;
}

.tab-pane {
  padding: 12px 0 !important;
}
.tabs {
  :deep(.n-tabs-tab) {
    padding: 6px 0;
  }
}

.divider {
  height: 1px;
  background-color: var(--bg-hover);
  margin-bottom: 14px;
  margin-top: -10px;
}
</style>
