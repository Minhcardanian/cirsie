/** Compare exact instructions using sequence alignment. Renamed identifiers are
 * deliberately not normalized: a textual match is not a semantic proof. */
export function compareInstructions(before, after, maxCells=2_000_000) {
  const a=before.map(x=>JSON.stringify(x)), b=after.map(x=>JSON.stringify(x));
  if ((a.length+1)*(b.length+1)>maxCells) {
    return {method:'positional', changes:Array.from({length:Math.max(a.length,b.length)},(_,i)=>({beforeIndex:i<a.length?i:null,afterIndex:i<b.length?i:null})).filter(x=>a[x.beforeIndex]!==b[x.afterIndex])};
  }
  const width=b.length+1, lengths=new Uint32Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--)
    lengths[i*width+j]=a[i]===b[j]?1+lengths[(i+1)*width+j+1]:Math.max(lengths[(i+1)*width+j],lengths[i*width+j+1]);
  const changes=[];let i=0,j=0;
  while(i<a.length || j<b.length){
    if(i<a.length && j<b.length && a[i]===b[j]){i++;j++;continue;}
    if(j<b.length && (i===a.length || lengths[i*width+j+1]>lengths[(i+1)*width+j])) changes.push({beforeIndex:null,afterIndex:j++});
    else if(i<a.length) changes.push({beforeIndex:i++,afterIndex:null});
    else changes.push({beforeIndex:null,afterIndex:j++});
  }
  return {method:'sequence',changes};
}
