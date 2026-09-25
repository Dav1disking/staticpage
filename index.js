const query=document.getElementById("query");
const results=document.getElementById("results");
const home=document.getElementById("home");
const address=document.getElementById("address");

document.getElementById("searchForm").addEventListener("submit",e=>{
  e.preventDefault();
  search(query.value);
});

document.querySelectorAll("[data-search]").forEach(button=>{
  button.addEventListener("click",()=>search(button.dataset.search));
});

async function search(term){
  term=term.trim();
  if(!term)return;

  query.value=term;
  home.hidden=true;
  results.hidden=false;
  address.value="search.local/search?q="+encodeURIComponent(term);

  results.innerHTML='<div class="count">Searching…</div>';

  try{
    const api="https://en.wikipedia.org/w/api.php?action=query&generator=search"+
      "&gsrsearch="+encodeURIComponent(term)+
      "&gsrnamespace=0&gsrlimit=10&prop=extracts"+
      "&exintro=1&explaintext=1&format=json&origin=*";

    const response=await fetch(api);
    if(!response.ok)throw new Error();

    const data=await response.json();
    const pages=Object.values(data.query?.pages||{});

    if(!pages.length){
      results.innerHTML='<div class="count">No results found for <b>'+esc(term)+'</b>.</div>';
      return;
    }

    results.innerHTML='<div class="count">Search results for <b>'+esc(term)+'</b></div>'+
      pages.map(page=>{
        const title=esc(page.title);
        const description=esc((page.extract||"No description available.").slice(0,350));
        const link="https://en.wikipedia.org/wiki/"+encodeURIComponent(page.title.replace(/ /g,"_"));

        return `<article class="result">
          <div class="site">wikipedia.org</div>
          <h2><a href="${link}" target="_blank" rel="noopener">${title}</a></h2>
          <p>${description}${page.extract?.length>350?"…":""}</p>
        </article>`;
      }).join("");
  }catch{
    results.innerHTML='<div class="error">Search could not load. Check your connection and try again.</div>';
  }
}

function goAddress(){
  const raw=address.value.trim();
  if(!raw)return;

  if(raw.startsWith("search.local/search?q=")){
    try{
      search(new URL("https://"+raw).searchParams.get("q")||"");
      return;
    }catch{}
  }

  let target=raw;

  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)){
    if(/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(target)){
      target="https://"+target;
    }else{
      search(raw);
      return;
    }
  }

  try{
    const url=new URL(target);
    if(url.protocol==="http:"||url.protocol==="https:"){
      window.location.href=url.href;
      return;
    }
  }catch{}

  search(raw);
}

address.addEventListener("keydown",e=>{
  if(e.key==="Enter"){
    e.preventDefault();
    goAddress();
  }
});

document.getElementById("go").addEventListener("click",goAddress);
document.getElementById("reload").addEventListener("click",()=>location.reload());
document.getElementById("back").addEventListener("click",()=>history.back());
document.getElementById("forward").addEventListener("click",()=>history.forward());

function esc(value){
  return String(value).replace(/[&<>"']/g,c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}