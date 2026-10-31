<script setup lang="ts">
import { useRouter } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import MarketplaceCatalog from '@/components/MarketplaceCatalog.vue'
import type { MarketplaceImage } from '@/api/containers'

const router = useRouter()

function deploy(template: MarketplaceImage) {
  void router.push({ path: '/applications', query: { template: template.id } })
}
</script>

<template>
  <AppLayout title="Marketplace" flex>
    <MarketplaceCatalog @deploy="deploy" />
  </AppLayout>
</template>
