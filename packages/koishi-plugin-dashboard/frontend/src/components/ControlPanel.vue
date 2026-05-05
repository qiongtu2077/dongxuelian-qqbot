<template>
  <div>
    <!-- Bot 状态卡片 -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">Bot 状态</h2>
        <span v-if="status.loading" style="color:#64748B">检测中...</span>
        <span v-else :style="{color: status.running ? '#39C5BB' : '#F472B6', fontSize:'14px', fontWeight:'700'}">
          {{ status.running ? '● 运行中' : '● 已停止' }}
        </span>
      </div>
      <div v-if="status.running" style="font-size:13px;color:#64748B;margin-top:4px">
        Worker 数量：{{ status.workers }}
      </div>
    </div>

    <!-- 控制按钮 -->
    <div class="card">
      <h2>控制</h2>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn" @click="doStart" :disabled="acting || status.running">
          {{ acting ? '执行中...' : '▶ 启动 Bot' }}
        </button>
        <button class="btn" style="background:#F472B6" @click="confirmStop" :disabled="acting || !status.running">
          {{ acting ? '执行中...' : '■ 停止 Bot' }}
        </button>
      </div>
      <div v-if="resultMsg" class="msg" :class="resultMsg.type" style="margin-top:12px">{{ resultMsg.text }}</div>
    </div>

    <!-- QQ 管理 -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="margin:0 0 4px">QQ 管理</h2>
          <div style="font-size:13px;color:#64748B">切换 QQ 账号、查看登录状态</div>
        </div>
        <button class="btn btn-sm" @click="showNapcat = !showNapcat">{{ showNapcat ? '关闭' : '打开' }}</button>
      </div>
      <div v-if="showNapcat" style="margin-top:12px;border-radius:8px;overflow:hidden;background:#0f1923">
        <iframe src="/webui/" style="width:100%;height:600px;border:none"></iframe>
      </div>
    </div>

    <!-- 维护模式 -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="margin:0 0 4px">维护模式</h2>
          <div style="font-size:13px;color:#64748B">开启后 bot 回复"优化中"，不触发 AI</div>
        </div>
        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer">
          <input type="checkbox" v-model="maintenanceOn" @change="toggleMaintenance" :disabled="maintLoading" style="opacity:0;width:0;height:0" />
          <span :style="{
            position:'absolute',inset:0,background:maintenanceOn ? '#39C5BB' : '#2a3a4a',borderRadius:'13px',transition:'.2s'
          }">
            <span :style="{
              position:'absolute',top:'3px',left:maintenanceOn ? '25px' : '3px',width:'20px',height:'20px',background:'#fff',borderRadius:'50%',transition:'.2s'
            }"></span>
          </span>
        </label>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { botStatus, startBot, stopBot, fetchMaintenance, setMaintenance } from '../api'

export default {
  name: 'ControlPanel',
  setup() {
    const status = ref({ loading: true, running: false, workers: 0 })
    const acting = ref(false)
    const showConfirm = ref(false)
    const resultMsg = ref(null)
    const maintenanceOn = ref(false)
    const maintLoading = ref(false)
    const showNapcat = ref(false)

    async function loadStatus() {
      const res = await botStatus()
      if (res.ok) status.value = { loading: false, ...res.data }
      else status.value = { loading: false, running: false, workers: 0 }
    }
    async function loadMaintenance() {
      const res = await fetchMaintenance()
      if (res.ok) maintenanceOn.value = res.data.enabled
    }

    onMounted(() => { loadStatus(); loadMaintenance() })

    async function doStart() {
      acting.value = true; resultMsg.value = null
      const res = await startBot()
      resultMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已发送启动命令，等待 15 秒验证...' : '启动失败') }
      acting.value = false
      if (res.ok) setTimeout(loadStatus, 15000)
      else loadStatus()
    }

    function confirmStop() { showConfirm.value = true }

    async function doStop() {
      showConfirm.value = false
      acting.value = true; resultMsg.value = null
      const res = await stopBot()
      resultMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已停止' : '停止失败') }
      acting.value = false
      loadStatus()
    }

    async function toggleMaintenance() {
      maintLoading.value = true
      const res = await setMaintenance(maintenanceOn.value)
      if (!res.ok) maintenanceOn.value = !maintenanceOn.value
      maintLoading.value = false
    }

    return { status, acting, showConfirm, resultMsg, maintenanceOn, maintLoading, doStart, confirmStop, doStop, toggleMaintenance, showNapcat }
  }
}
</script>
