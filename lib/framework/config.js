export const DEFAULT_IGNORE_RULES = Object.freeze([
  'node_modules', '.git', '.cache', 'dist', 'build', '*.log', '*.tmp', 'secrets',
  '*.key', '*.pem', '*.p12', '*.pfx', '*.env', '.env', 'cookies', 'tokens', 'credentials',
])

                                         
                                                                               

                                      
                  
                     
                
                                
                                
 

                                  
                  
                         
                           
                        
                
                        
                            
                          
 

                               
                                    
                            
           
                        
                                
                          
                      
                            
                         
   
 

export function createDefaultConfig()               {
  return {
    workspaceSync: {
      enabled: false,
      root: null,
      mode: 'manual',
      conflictPolicy: 'ask',
      ignoreRules: [...DEFAULT_IGNORE_RULES],
    },
    broadcast: {
      enabled: false,
      allowLocalHttp: false,
      includeSelection: false,
      receivePaused: false,
      muted: false,
      maxTitleLength: 240,
      maxSelectionLength: 4000,
      maxMessageLength: 2000,
    },
    limits: {
      maxFileBytes: 256 * 1024 * 1024,
      maxConcurrentUploads: 2,
      maxQueuedTasks: 100,
      chunkBytes: 512 * 1024,
      requestTimeoutMs: 60_000,
      retryAttempts: 3,
    },
  }
}

export function mergeConfig(input                                   )               {
  const defaults = createDefaultConfig()
  const value = input ?? {}
  return {
    ...defaults,
    ...value,
    workspaceSync: {
      ...defaults.workspaceSync,
      ...(value.workspaceSync ?? {}),
      ignoreRules: [...(value.workspaceSync?.ignoreRules ?? defaults.workspaceSync.ignoreRules)],
    },
    broadcast: { ...defaults.broadcast, ...(value.broadcast ?? {}) },
    limits: { ...defaults.limits, ...(value.limits ?? {}) },
  }
}
