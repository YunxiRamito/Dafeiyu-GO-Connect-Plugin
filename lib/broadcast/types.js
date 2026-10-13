/** High-level launcher boundary for DSH web broadcast. */
                                                                                                                                            
                                                              

                                             
                           
                           
                  
                         
                                  
                                     
 

                                   
                   
                    
                             
                
               
                
                          
                 
 

                                                             
                         
                     
 

                                    
                                                                                  
                                                                                
                                                                                      
 

                                  
                    
                          
                          
                        
                         
                             
                          
 

                                 
                 
               
                        
                               
 

                                  
                              
                                                                                        
                      
                 
                             
 

                                     
                                               
                                            
 

                                      
                    
                     
                  
 

export class BroadcastError extends Error {
           code        ;
           cause          ;

  constructor(code        , message        , cause          ) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.cause = cause;
  }
}

export const DEFAULT_BROADCAST_CONFIG                            = {
  enabled: false,
  allowLocalDsh: false,
  maxTitleLength: 200,
  maxUrlLength: 2048,
  maxTextLength: 4000,
  maxHistoryEntries: 100,
  dedupeWindowMs: 10 * 60 * 1000,
};
