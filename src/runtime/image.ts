import type { CreateImageOptions, ImageModifiers, ImagePreset, ImageSize } from 'types'
import { getMeta } from './meta'
import { cleanDoubleSlashes } from './utils'

let pagePayload = null

function processSource (src: string) {
  if (!src.includes(':') || src.match('^https?://')) {
    return { src }
  }

  const [srcConfig, ...rest] = src.split(':')
  const [provider, preset] = srcConfig.split('+')

  return {
    src: rest.join(':'),
    provider,
    preset
  }
}

function getCache (context) {
  if (!context.cache) {
    if (context.ssrContext && context.ssrContext.cache) {
      context.cache = context.ssrContext.cache
    } else {
      const _cache = {}
      context.cache = {
        get: id => _cache[id],
        set: (id, value) => { _cache[id] = value },
        has: id => typeof _cache[id] !== 'undefined'
      }
    }
  }
  return context.cache
}

export function createImage (context, { providers, defaultProvider, presets, intersectOptions, responsiveSizes }: CreateImageOptions) {
  const presetMap = presets.reduce((map, preset) => {
    map[preset.name] = preset
    return map
  }, {})

  if ('app' in context) {
    context.app.router.afterEach((page) => {
      fetchPayload(page, context)
    })
  }

  function getProvider (name: string) {
    const provider = providers[name]
    if (!provider) {
      throw new Error('Unsupported provider ' + name)
    }
    return provider
  }

  function getPreset (name: string): ImagePreset | false {
    if (!name) {
      return false
    }
    if (!presetMap[name]) {
      throw new Error('Unsupported preset ' + name)
    }
    return presetMap[name]
  }

  function parseImage (source: string, modifiers: ImageModifiers, options: any = {}) {
    const { src, provider: sourceProvider, preset: sourcePreset } = processSource(source)
    const provider = getProvider(sourceProvider || options.provider || defaultProvider)
    const preset = getPreset(sourcePreset || options.preset)

    const image = provider.provider.getImage(
      src,
      preset ? preset.modifiers : modifiers,
      { ...provider.defaults, ...options }
    )
    return {
      src,
      provider,
      preset,
      image
    }
  }

  function image (source: string, modifiers: ImageModifiers, options: any = {}) {
    const { src, image } = parseImage(source, modifiers, options)
    const { url: providerUrl, isStatic } = image

    /**
     * Handle full static render
     */
    // @ts-ignore
    if (global.$nuxt) {
      // @ts-ignore
      const jsonPData = pagePayload
      if ('nuxtImageMap' in jsonPData && jsonPData.nuxtImageMap[providerUrl]) {
        // Hydration with hash
        image.url = jsonPData.nuxtImageMap[providerUrl]
      } else if (image.isStatic) {
        image.url = src
      }
      // return original source on cache fail in full static mode
      return image
    }

    /**
     * Handle client side rendering without server
     */
    if (!context.isDev && typeof window !== 'undefined' && context.isStatic && image.isStatic) {
      image.url = src
      return image
    }

    const nuxtState = context.nuxtState || context.ssrContext.nuxt
    if (!nuxtState.data || !nuxtState.data.length) {
      nuxtState.data = [{}]
    }
    const data = nuxtState.data[0]
    data.nuxtImageMap = data.nuxtImageMap || {}
    const url = providerUrl
    if (data.nuxtImageMap[url]) {
      // Hydration with hash
      image.url = data.nuxtImageMap[url]
    } else if (context.ssrContext && typeof context.ssrContext.mapImage === 'function') {
      // Full Static
      const mappedUrl = context.ssrContext.mapImage({ url, isStatic, format: modifiers.format, src })
      if (mappedUrl) {
        image.url = data.nuxtImageMap[providerUrl] = mappedUrl
      }
    }
    return image
  }

  presets.forEach((preset) => {
    image[preset.name] = (src) => {
      return image(src, preset.modifiers, {
        provider: preset.provider
      })
    }
  })

  image.sizes = (src: string, sizes: Array<Partial<ImageSize>> | string | boolean, operations: any = {}) => {
    if (typeof sizes === 'string') {
      sizes = sizes
        .split(',')
        .map(set => set.match(/((\d+):)?(\d+)\s*(\((\w+)\))?/))
        .filter(match => !!match)
        .map((match, index): Partial<ImageSize> => ({
          width: parseInt(match[3], 10),
          breakpoint: parseInt(match[2] || (index > 0 && match[3]), 10),
          format: match[5] || operations.format
        }))
    }
    if (!Array.isArray(sizes)) {
      if (sizes === true) {
        sizes = responsiveSizes.map(width => ({
          width,
          breakpoint: width,
          format: operations.format
        }))
      } else {
        sizes = [{}]
      }
    }

    sizes = (sizes as Array<ImageSize>).map((size) => {
      if (!size.format) {
        size.format = operations.format
      }
      if (!size.media) {
        size.media = size.breakpoint ? `(min-width: ${size.breakpoint}px)` : ''
      }
      const { url } = image(src, {
        ...operations,
        width: size.width,
        format: size.format
      })
      size.url = url
      return size
    })

    return sizes
  }

  image.getMeta = async (source: string, modifiers: ImageModifiers, options: any = {}) => {
    const { image } = parseImage(source, { ...modifiers, width: 30, quality: 40 }, options)

    const meta = { placeholder: image.url }

    if (typeof image.getMeta === 'function') {
      Object.assign(meta, await image.getMeta())
    } else {
      const internalUrl = context.ssrContext ? context.ssrContext.internalUrl : ''
      let absoluteUrl
      if (image.url[0] === '/') {
        absoluteUrl = cleanDoubleSlashes(internalUrl + context.base + image.url)
      } else {
        absoluteUrl = image.url
      }
      Object.assign(meta, await getMeta(absoluteUrl, getCache(context)))
    }

    return meta
  }

  image.$observer = createObserver(intersectOptions)

  return image
}

async function fetchPayload (page, context) {
  if (!context.nuxtState) {
    context.beforeNuxtRender(({ nuxtState }) => {
      pagePayload = nuxtState.data[0]
    })
  } else {
    try {
      // @ts-ignore
      const payload = await window.__NUXT_IMPORT__(decodeURI(page.path.replace(/\/$/, '')), encodeURI(context.nuxtState.staticAssetsBase + page.path + 'payload.js'))
      pagePayload = payload.data[0]
    } catch (e) {
      pagePayload = (context.nuxtState.data || [{}])[0] || {}
    }
  }
}

function printObserver (onMatch) {
  if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
    return
  }

  const mediaQueryList = window.matchMedia('print')
  mediaQueryList.addListener((query) => {
    if (query.matches) {
      onMatch()
    }
  })
}

function intersectionObserver (onMatch, options) {
  const observer = (typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(onMatch, {
    rootMargin: '50px',
    ...options
  }) : {}) as IntersectionObserver

  return observer
}

function createObserver (intersectionOptions: object) {
  const callbackType = { intersect: 'onIntersect', print: 'onPrint' }
  const elementCallbackMap = {}
  function intersectionCallback (entries, imgObserver) {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const lazyImage = entry.target
        const callback = elementCallbackMap[lazyImage.__unique]
        if (typeof callback === 'function') {
          callback(callbackType.intersect)
        }
        delete elementCallbackMap[lazyImage.__unique]
        imgObserver.unobserve(lazyImage)
      }
    })
  }

  printObserver(() => {
    Object.values(elementCallbackMap).forEach((callback: any) => callback(callbackType.print))
  })

  const intersectObserver = intersectionObserver(intersectionCallback, intersectionOptions)

  return {
    add (target, component, unique) {
      // add unique id to recognize target
      target.__unique = unique || target.id || target.__vue__._uid
      elementCallbackMap[target.__unique] = component
      intersectObserver.observe(target)
    },
    remove (target) {
      delete elementCallbackMap[target.__unique]
      intersectObserver.unobserve(target)
    }
  }
}
